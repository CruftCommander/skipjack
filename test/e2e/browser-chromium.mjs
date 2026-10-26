// Chromium back end for the end-to-end checks: Playwright's Chromium with the built extension from
// dist/chromium, every request answered by the mock site through Playwright's request routing.
// Exposes the browser-neutral interface described in harness.mjs.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMockSite } from './mock.mjs';

// Lets Playwright see the extension service worker's own requests, so they can be mocked.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

/** Playwright is not a dependency. PLAYWRIGHT may name another copy, by package name or path. */
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT ?? 'playwright';
  try {
    return await import(isAbsolute(spec) ? pathToFileURL(spec).href : spec);
  } catch (error) {
    console.error(`Could not load Playwright (${spec}). From the repository root, run:\n  npm install --no-save playwright@1.56.0\n  npx playwright install chromium`);
    throw error;
  }
}

/** All text on the page, including inside shadow roots, where the toast lives. */
const allText = () => {
  const out = [];
  const walk = (root) => {
    out.push(root.textContent ?? '');
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  return out.join(' ');
};

export async function launchChromium({ repo, videos, sponsorblock }) {
  const { chromium } = await loadPlaywright();
  const ext = join(repo, 'dist', 'chromium');
  const site = await createMockSite({ videos, sponsorblock });
  const profile = await mkdtemp(join(tmpdir(), 'skipjack-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.HEADED ? false : true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  });
  for (const pattern of ['https://sponsor.ajay.app/**', 'https://api.anthropic.com/**', 'https://api.openai.com/**', 'https://www.youtube.com/**']) {
    await ctx.route(pattern, (r) => r.fulfill(site.respond(r.request().url(), r.request().headers()['range'] ?? '')));
  }

  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  const wrap = (page) => ({
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    text: (selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector),
    allText: () => page.evaluate(allText),
    click: (selector) => page.click(selector),
    fill: (selector, value) => page.fill(selector, value),
    close: () => page.close(),
    /**
     * Chromium only: what a content script on this page can read from extension storage. Returns
     * { local, sync }, each 'readable' or 'blocked: <reason>'.
     */
    async contentScriptStorage() {
      const cdp = await ctx.newCDPSession(page);
      const contexts = [];
      cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
      await cdp.send('Runtime.enable');
      await new Promise((r) => setTimeout(r, 300));
      const isolated = contexts.find((c) => c.auxData?.type === 'isolated' && /Skipjack/.test(c.name));
      if (!isolated) throw new Error(`content script context not found among ${JSON.stringify(contexts.map((c) => [c.name, c.auxData?.type]))}`);
      const ev = async (area) => {
        const r = await cdp.send('Runtime.evaluate', {
          expression: `chrome.storage.${area}.get(null).then(() => 'readable', (e) => 'blocked: ' + e.message)`,
          contextId: isolated.id,
          awaitPromise: true,
          returnByValue: true,
        });
        return r.result.value;
      };
      return { local: await ev('local'), sync: await ev('sync') };
    },
  });

  return {
    browser: 'chromium',
    calls: site.calls,
    local: () => sw.evaluate(() => chrome.storage.local.get(null)),
    setLocal: (items) => sw.evaluate((items) => chrome.storage.local.set(items), items),
    async open(id) {
      const page = await ctx.newPage();
      const logs = [];
      page.on('console', (m) => {
        if (m.text().includes('[Skipjack]')) logs.push(m.text());
      });
      await page.goto(`https://www.youtube.com/watch?v=${id}`);
      return { page: wrap(page), logs };
    },
    async openSettings() {
      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${extId}/options.html`);
      return wrap(page);
    },
    async close() {
      await ctx.close();
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
