// The local proxy both browser back ends point at. It terminates every CONNECT tunnel itself with a
// throwaway self-signed certificate and answers from the mock site in mock.mjs, so no request leaves
// the machine. Each browser is told to accept any certificate, so the certificate only has to exist.
// Making it needs openssl; OPENSSL names it when it is not on PATH or in Git for Windows.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { delimiter, join } from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';

const win = process.platform === 'win32';

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findOpenssl() {
  if (process.env.OPENSSL) return process.env.OPENSSL;
  for (const c of ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) if (await isFile(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const file of win ? ['openssl.exe', 'openssl'] : ['openssl']) if (dir && (await isFile(join(dir, file)))) return join(dir, file);
  }
  throw new Error('openssl not found. Set OPENSSL to its path, or see test/e2e/README.md.');
}

/** A throwaway self-signed certificate for the mock hosts, valid for two days. */
export async function makeCertificate(dir) {
  const openssl = await findOpenssl();
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const hosts = ['www.youtube.com', 'm.youtube.com', 'sponsor.ajay.app', 'api.anthropic.com', 'api.openai.com'];
  await promisify(execFile)(openssl, [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=Skipjack e2e',
    '-addext', `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(',')}`,
  ]);
  return { key: await readFile(key), cert: await readFile(cert) };
}

/**
 * An HTTP proxy that terminates every CONNECT tunnel itself and answers from the mock site. Plain
 * HTTP requests get a 404. Returns the port.
 */
export async function startProxy(site, { key, cert }) {
  const secureContext = tls.createSecureContext({ key, cert });
  const app = http.createServer((req, res) => {
    const { status, headers, body } = site.respond(`https://${req.headers.host}${req.url}`, req.headers.range ?? '');
    res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  const proxy = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  proxy.on('connect', (req, socket, head) => {
    socket.on('error', () => undefined);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
    secure.on('error', () => undefined);
    if (head?.length) secure.unshift(head);
    app.emit('connection', secure);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return {
    port: proxy.address().port,
    close: () => {
      app.closeAllConnections();
      proxy.closeAllConnections();
      return Promise.all([new Promise((r) => app.close(() => r())), new Promise((r) => proxy.close(() => r()))]);
    },
  };
}

