// Firefox back end for the end-to-end checks: a real Firefox driven through geckodriver (WebDriver
// over HTTP, plus a BiDi WebSocket for console messages; no client library), with dist/firefox
// installed as a temporary add-on. Firefox cannot
// route requests the way Playwright does, so every request goes through a local proxy that answers
// HTTPS itself with a throwaway certificate and the mock site's responses. The session accepts any
// certificate, so the certificate only has to exist. Exposes the browser-neutral interface described
// in harness.mjs.
//
// Needs Firefox 140 or later, geckodriver 0.36 or later (for --allow-system-access), and openssl.
// FIREFOX, GECKODRIVER, and OPENSSL name the binaries when they are not on PATH or in the default
// places below.

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { createMockSite } from './mock.mjs';

const win = process.platform === 'win32';
const cache = join(homedir(), '.cache', 'skipjack-e2e');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The first that exists: the env var, then the default install places, then PATH. The default
 * places come before PATH because PATH on Windows can hold launchers and shims named like the
 * browser (a package manager's, or the Store alias), which geckodriver rejects as not Firefox.
 */
async function findBinary(name, envVar, candidates) {
  if (process.env[envVar]) return process.env[envVar];
  for (const c of candidates) if (await isFile(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const file of win ? [`${name}.exe`, name] : [name]) if (dir && (await isFile(join(dir, file)))) return join(dir, file);
  }
  throw new Error(`${name} not found. Set ${envVar} to its path, or see test/e2e/README.md for the download.`);
}

/** Default places: ~/.cache/skipjack-e2e, the repository's git-ignored .cache, then the usual installs. */
const findFirefox = (repo) =>
  findBinary('firefox', 'FIREFOX', [
    join(cache, 'firefox', 'firefox'),
    join(repo, '.cache', 'firefox', 'firefox'),
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
  ]);
const findGeckodriver = (repo) => {
  const file = win ? 'geckodriver.exe' : 'geckodriver';
  return findBinary('geckodriver', 'GECKODRIVER', [join(cache, file), join(repo, '.cache', file)]);
};
const findOpenssl = () => findBinary('openssl', 'OPENSSL', ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']);

/** A throwaway self-signed certificate for the mock hosts, valid for two days. */
async function makeCertificate(dir) {
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
async function startProxy(site, { key, cert }) {
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

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Starts geckodriver on a free port and waits until it answers. */
async function startGeckodriver(repo) {
  const geckodriver = await findGeckodriver(repo);
  console.log(`geckodriver: ${geckodriver}`);
  const port = await freePort();
  const child = spawn(geckodriver, ['--port', String(port), '--host', '127.0.0.1', '--allow-system-access'], { stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/status`);
      if (r.ok) break;
    } catch {
      await sleep(100);
    }
  }
  return {
    base,
    async stop() {
      child.kill();
      await Promise.race([exited, sleep(5000)]);
    },
  };
}

export async function launchFirefox({ repo, videos, sponsorblock }) {
  const firefox = await findFirefox(repo);
  console.log(`Firefox: ${firefox}`);
  const site = await createMockSite({ videos, sponsorblock });
  const work = await mkdtemp(join(tmpdir(), 'skipjack-e2e-'));
  const proxy = await startProxy(site, await makeCertificate(work));

  const driver = await startGeckodriver(repo);

  /** One WebDriver command. Throws on a WebDriver error. Every POST carries a JSON body, as geckodriver requires. */
  async function wd(method, path, body = {}) {
    const r = await fetch(driver.base + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
    const { value } = await r.json();
    if (value && typeof value === 'object' && 'error' in value) throw new Error(`${method} ${path}: ${value.error}: ${value.message}`);
    return value;
  }

  const session = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        acceptInsecureCerts: true,
        // Also opens a WebDriver BiDi connection, used below to read console messages.
        webSocketUrl: true,
        proxy: { proxyType: 'manual', httpProxy: `127.0.0.1:${proxy.port}`, sslProxy: `127.0.0.1:${proxy.port}`, noProxy: [] },
        'moz:firefoxOptions': {
          binary: firefox,
          args: process.env.HEADED ? [] : ['-headless'],
          prefs: {
            'media.autoplay.default': 0,
            'media.autoplay.blocking_policy': 0,
            // Grants host_permissions at install, as Firefox does for a signed install from AMO.
            'extensions.originControls.grantByDefault': true,
            // The throwaway certificate is not from a built-in root, and YouTube's hosts are pinned.
            'security.cert_pinning.enforcement_level': 0,
            // Keeps Firefox's own services off the proxy.
            'services.settings.server': 'data:,#remote-settings-dummy/v1',
            'browser.safebrowsing.provider.mozilla.updateURL': '',
            'browser.safebrowsing.provider.mozilla.gethashURL': '',
          },
        },
      },
    },
  });
  const sid = session.sessionId;
  const s = (path) => `/session/${sid}${path}`;

  // Console messages arrive over WebDriver BiDi, each tagged with the browsing context (the tab) it
  // came from. Firefox's classic window handles are those same context IDs, so open() can register
  // its tab's log array by handle. Firefox on Windows writes nothing to stdout, so this is the one
  // route that works everywhere.
  const logsByContext = new Map();
  const bidi = new WebSocket(session.capabilities.webSocketUrl);
  await new Promise((resolve, reject) => {
    bidi.addEventListener('open', resolve, { once: true });
    bidi.addEventListener('error', () => reject(new Error('could not open the BiDi connection')), { once: true });
  });
  bidi.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type !== 'event' || message.method !== 'log.entryAdded') return;
    const { text, args, source } = message.params;
    const line = text ?? (args ?? []).map((a) => (a.type === 'string' ? a.value : JSON.stringify(a.value ?? a.type))).join(' ');
    if (line.includes('[Skipjack]')) logsByContext.get(source?.context)?.push(line);
  });
  bidi.send(JSON.stringify({ id: 1, method: 'session.subscribe', params: { events: ['log.entryAdded'] } }));
  const addonId = await wd('POST', s('/moz/addon/install'), { path: join(repo, 'dist', 'firefox'), temporary: true });
  const [home] = await wd('GET', s('/window/handles'));

  const current = () => wd('GET', s('/window'));
  const switchTo = (handle) => wd('POST', s('/window'), { handle });
  /** Runs `fn` with `handle` as the current window, then switches back. */
  async function withHandle(handle, fn) {
    const before = await current();
    if (before !== handle) await switchTo(handle);
    try {
      return await fn();
    } finally {
      if (before !== handle) await switchTo(before).catch(() => undefined);
    }
  }
  const run = (fn, arg) => wd('POST', s('/execute/sync'), { script: `return (${fn})(arguments[0]);`, args: [arg ?? null] });
  const runAsync = (fn, arg) => wd('POST', s('/execute/async'), { script: `const done = arguments[1]; Promise.resolve((${fn})(arguments[0])).then(done, (e) => done({ __error: String(e?.message ?? e) }));`, args: [arg ?? null] });
  const element = async (selector) => (await wd('POST', s('/element'), { using: 'css selector', value: selector }))['element-6066-11e4-a52e-4f735466cecf'];

  /**
   * Opens one of the extension's own pages in a new tab. Marionette refuses to navigate a content tab
   * to moz-extension://, so the tab is opened from chrome context, which also knows the add-on's URL.
   */
  async function openExtensionPage(file) {
    const before = await wd('GET', s('/window/handles'));
    await wd('POST', s('/moz/context'), { context: 'chrome' });
    try {
      await wd('POST', s('/execute/sync'), {
        script: `
          const policy = WebExtensionPolicy.getByID(arguments[0]);
          if (!policy) throw new Error('add-on not installed: ' + arguments[0]);
          const win = Services.wm.getMostRecentWindow('navigator:browser');
          const tab = win.gBrowser.addTab(policy.getURL(arguments[1]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          win.gBrowser.selectedTab = tab;`,
        args: [addonId, file],
      });
    } finally {
      await wd('POST', s('/moz/context'), { context: 'content' });
    }
    let handle = null;
    for (let i = 0; i < 100 && !handle; i++) {
      handle = (await wd('GET', s('/window/handles'))).find((h) => !before.includes(h)) ?? null;
      if (!handle) await sleep(50);
    }
    if (!handle) throw new Error(`no new tab for ${file}`);
    await switchTo(handle);
    // The new tab starts as about:blank, which is already "complete": wait for the extension page itself.
    for (let i = 0; i < 100; i++) {
      if ((await run(() => `${location.protocol} ${document.readyState}`)) === 'moz-extension: complete') break;
      await sleep(50);
    }
    return handle;
  }

  const wrap = (handle) => ({
    evaluate: (fn, arg) => withHandle(handle, () => run(fn, arg)),
    text: (selector) => withHandle(handle, () => run((sel) => document.querySelector(sel)?.textContent ?? null, selector)),
    allText: () =>
      withHandle(handle, () =>
        run(() => {
          const out = [];
          const walk = (root) => {
            out.push(root.textContent ?? '');
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
          };
          walk(document);
          return out.join(' ');
        }),
      ),
    click: (selector) => withHandle(handle, async () => wd('POST', s(`/element/${await element(selector)}/click`))),
    fill: (selector, value) =>
      withHandle(handle, async () => {
        const el = await element(selector);
        await wd('POST', s(`/element/${el}/clear`));
        await wd('POST', s(`/element/${el}/value`), { text: value });
      }),
    async close() {
      await switchTo(handle);
      await wd('DELETE', s('/window'));
      await switchTo(home);
    },
  });

  // A settings tab kept open for the whole run, as the extension context that reads and writes storage.
  const service = await openExtensionPage('options.html');
  const storage = async (fn, arg) => {
    const result = await withHandle(service, () => runAsync(fn, arg));
    if (result && typeof result === 'object' && '__error' in result) throw new Error(result.__error);
    return result;
  };
  await switchTo(home);

  return {
    browser: 'firefox',
    calls: site.calls,
    local: () => storage(() => browser.storage.local.get(null)),
    setLocal: (items) => storage((items) => browser.storage.local.set(items), items),
    async open(id) {
      const { handle } = await wd('POST', s('/window/new'), { type: 'tab' });
      await switchTo(handle);
      const logs = [];
      logsByContext.set(handle, logs);
      await wd('POST', s('/url'), { url: `https://www.youtube.com/watch?v=${id}` });
      return { page: wrap(handle), logs };
    },
    openSettings: async () => wrap(await openExtensionPage('options.html')),
    async close() {
      bidi.close();
      await wd('DELETE', s('')).catch(() => undefined);
      await driver.stop();
      await proxy.close();
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
