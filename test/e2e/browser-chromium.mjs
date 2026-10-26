// Chromium back end for the end-to-end checks: Edge, Chrome, or a plain Chromium build, driven over
// the Chrome DevTools Protocol (CDP) through the browser's debugging pipe, with no client library.
// Edge and Chrome 137 and later no longer accept --load-extension, so dist/chromium is loaded with the
// CDP command Extensions.loadUnpacked, which the browser allows only when started with
// --remote-debugging-pipe and --enable-unsafe-extension-debugging. Every request goes through the
// same local proxy as the Firefox back end, and --ignore-certificate-errors accepts its throwaway
// certificate. Exposes the browser-neutral interface described in harness.mjs.
//
// `--edge` picks Edge, `--chrome` picks Chrome; otherwise the first found of Edge, Chrome, and
// Playwright's Chromium. EDGE, CHROME, and CHROMIUM name the executable when it is somewhere else.

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createMockSite } from './mock.mjs';
import { makeCertificate, startProxy } from './proxy.mjs';

const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Playwright's Chromium builds, newest first, in its cache folders and this workspace's. */
async function playwrightChromiums() {
  const roots = [join(homedir(), '.cache', 'ms-playwright'), join(homedir(), 'AppData', 'Local', 'ms-playwright'), join(homedir(), 'Library', 'Caches', 'ms-playwright'), '/opt/pw-browsers'];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.unshift(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const out = [];
  for (const root of roots) {
    const names = await readdir(root).catch(() => []);
    for (const name of names.filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const dir = join(root, name);
      for (const sub of await readdir(dir).catch(() => [])) {
        if (/^chrome-(linux|win|mac)/.test(sub)) out.push(join(dir, sub, win ? 'chrome.exe' : mac ? 'Chromium.app/Contents/MacOS/Chromium' : 'chrome'));
      }
    }
  }
  return out;
}

const PLACES = {
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ],
};
const ON_PATH = { edge: ['msedge'], chrome: ['google-chrome', 'chrome'], chromium: ['chromium', 'chromium-browser'] };

/** The executable for `want`: 'edge', 'chrome', or 'chromium' (any of them, or Playwright's build). */
async function findBrowser(want, repo) {
  const env = { edge: 'EDGE', chrome: 'CHROME', chromium: 'CHROMIUM' }[want];
  if (process.env[env]) return { browser: want, binary: process.env[env] };
  const kinds = want === 'chromium' ? ['edge', 'chrome'] : [want];
  for (const kind of kinds) {
    for (const c of PLACES[kind]) if (await isFile(c)) return { browser: kind, binary: c };
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      for (const name of ON_PATH[kind]) for (const file of win ? [`${name}.exe`] : [name]) if (dir && (await isFile(join(dir, file)))) return { browser: kind, binary: join(dir, file) };
    }
  }
  if (want === 'chromium') {
    for (const c of [join(repo, '.cache', 'chromium', win ? 'chrome.exe' : 'chrome'), ...(await playwrightChromiums())]) if (await isFile(c)) return { browser: 'chromium', binary: c };
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      for (const name of ON_PATH.chromium) for (const file of win ? [`${name}.exe`] : [name]) if (dir && (await isFile(join(dir, file)))) return { browser: 'chromium', binary: join(dir, file) };
    }
  }
  throw new Error(`${want} not found. Set ${env} to its path, or see test/e2e/README.md.`);
}

/**
 * Starts the browser with the debugging pipe on file descriptors 3 (commands) and 4 (replies), and
 * returns a CDP client: send(method, params, sessionId), on(method, listener), plus stop().
 */
function startBrowser(binary, args) {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const pending = new Map();
  const listeners = [];
  let nextId = 0;
  let buffer = '';
  child.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString();
    let cut;
    while ((cut = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
        else resolve(message.result);
      } else {
        for (const l of listeners) l(message);
      }
    }
  });
  const exited = new Promise((r) => child.on('exit', r));
  child.on('exit', () => {
    for (const { reject } of pending.values()) reject(new Error('the browser exited'));
    pending.clear();
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
      });
    },
    on(method, listener) {
      listeners.push((m) => {
        if (m.method === method) listener(m.params, m.sessionId);
      });
    },
    async stop() {
      child.kill();
      await Promise.race([exited, sleep(5000)]);
    },
  };
}

export async function launchChromium({ repo, want = 'chromium', videos, sponsorblock }) {
  const { browser, binary } = await findBrowser(want, repo);
  console.log(`${browser}: ${binary}`);
  const site = await createMockSite({ videos, sponsorblock });
  const work = await mkdtemp(join(tmpdir(), 'skipjack-e2e-'));
  const proxy = await startProxy(site, await makeCertificate(work));
  const profile = join(work, 'profile');

  const args = [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    `--proxy-server=127.0.0.1:${proxy.port}`,
    // The proxy answers HTTPS with a throwaway certificate.
    '--ignore-certificate-errors',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  if (!process.env.HEADED) args.unshift('--headless=new');
  // Chromium refuses to sandbox when run as root, as in a container.
  if (!win && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
  const cdp = startBrowser(binary, args);
  const version = await cdp.send('Browser.getVersion');
  console.log(`${browser}: ${version.product}`);

  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: join(repo, 'dist', 'chromium') });
  // The extension's own URL scheme (chrome-extension:, or extension: on Edge), read from its service worker.
  let extOrigin = null;
  for (let i = 0; i < 100 && !extOrigin; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(`://${extId}/`));
    // Not URL.origin: Node reports "null" for schemes it does not know.
    if (sw) extOrigin = sw.url.slice(0, sw.url.indexOf(`/${extId}/`) + extId.length + 1);
    else await sleep(50);
  }
  if (!extOrigin) throw new Error('the extension service worker did not start');

  /** Attaches to a target and returns a session: evaluate(), plus the raw session id. */
  async function attach(targetId) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (params, sid) => {
      if (sid === sessionId) contexts.push(params.context);
    });
    cdp.on('Runtime.executionContextsCleared', (_params, sid) => {
      if (sid === sessionId) contexts.length = 0;
    });
    await cdp.send('Runtime.enable', {}, sessionId);
    const evaluate = async (expression, contextId) => {
      const params = { expression, returnByValue: true, awaitPromise: true };
      if (contextId !== undefined) params.contextId = contextId;
      const r = await cdp.send('Runtime.evaluate', params, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    return { sessionId, contexts, evaluate };
  }

  /** Opens `url` in a new tab, attached before navigation so console and context events are not missed. */
  async function openTab(url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const session = await attach(targetId);
    const logs = [];
    cdp.on('Runtime.consoleAPICalled', (params, sid) => {
      if (sid !== session.sessionId) return;
      const text = params.args.map((a) => (a.type === 'string' ? a.value : a.description ?? JSON.stringify(a.value))).join(' ');
      if (text.includes('[Skipjack]')) logs.push(text);
    });
    await cdp.send('Page.enable', {}, session.sessionId);
    const loaded = new Promise((resolve) => {
      cdp.on('Page.loadEventFired', (_params, sid) => {
        if (sid === session.sessionId) resolve();
      });
    });
    await cdp.send('Page.navigate', { url }, session.sessionId);
    await loaded;
    return { targetId, session, logs };
  }

  const wrap = ({ targetId, session }) => {
    const run = (fn, arg) => session.evaluate(`(${fn})(${JSON.stringify(arg ?? null)})`);
    return {
      evaluate: run,
      text: (selector) => run((sel) => document.querySelector(sel)?.textContent ?? null, selector),
      allText: () =>
        run(() => {
          const out = [];
          const walk = (root) => {
            out.push(root.textContent ?? '');
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
          };
          walk(document);
          return out.join(' ');
        }),
      click: (selector) => run((sel) => document.querySelector(sel).click(), selector),
      fill: (selector, value) =>
        run(
          ([sel, v]) => {
            const el = document.querySelector(sel);
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          },
          [selector, value],
        ),
      close: () => cdp.send('Target.closeTarget', { targetId }),
      /**
       * What a content script on this page can read from extension storage: { local, sync }, each
       * 'readable' or 'blocked: <reason>'. Runs in the content script's isolated world.
       */
      async contentScriptStorage() {
        const isolated = session.contexts.find((c) => c.auxData?.type === 'isolated' && /Skipjack/.test(c.name));
        if (!isolated) throw new Error(`content script context not found among ${JSON.stringify(session.contexts.map((c) => [c.name, c.auxData?.type]))}`);
        const read = (area) => session.evaluate(`chrome.storage.${area}.get(null).then(() => 'readable', (e) => 'blocked: ' + e.message)`, isolated.id);
        return { local: await read('local'), sync: await read('sync') };
      },
    };
  };

  // A settings tab kept open for the whole run, as the extension context that reads and writes storage.
  const service = await openTab(`${extOrigin}/options.html`);
  const storage = (fn, arg) => service.session.evaluate(`(${fn})(${JSON.stringify(arg ?? null)})`);

  return {
    browser,
    calls: site.calls,
    local: () => storage(() => chrome.storage.local.get(null)),
    setLocal: (items) => storage((items) => chrome.storage.local.set(items), items),
    async open(id) {
      const tab = await openTab(`https://www.youtube.com/watch?v=${id}`);
      return { page: wrap(tab), logs: tab.logs };
    },
    openSettings: async () => wrap(await openTab(`${extOrigin}/options.html`)),
    async close() {
      await cdp.send('Browser.close').catch(() => undefined);
      await cdp.stop();
      await proxy.close();
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
