// Shared harness for the end-to-end checks. Picks the browser (Chromium through Playwright, or Firefox
// through geckodriver with `--firefox`), starts it with the built extension and the mock YouTube site
// from mock.mjs, and gives the check scripts one browser-neutral interface:
//
//   browser                     'chromium' or 'firefox'
//   calls                       request counts per mocked API: anthropic, openai, sponsorblock, captions
//   open(id)                    opens a mock watch page: { page, logs } with the page's [Skipjack] console lines
//   openSettings()              opens the extension's settings page
//   local() / setLocal(items)   the extension's local storage, from an extension context
//   check(name, ok, detail)     records and prints one PASS or FAIL line
//   skip(name, reason)          prints one SKIP line for a check the browser cannot run
//   finish()                    closes the browser, prints the tally, returns the exit code
//
// A page has evaluate(fn, arg), text(selector), allText() (including shadow roots, where the toast
// lives), click(selector), fill(selector, value), close(), and on Chromium contentScriptStorage().
// Nothing here reaches the real sites. See README.md in this folder.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

/** `--firefox` on the command line, or SKIPJACK_E2E_BROWSER=firefox, picks Firefox; Chromium otherwise. */
export function chosenBrowser() {
  return process.argv.includes('--firefox') || process.env.SKIPJACK_E2E_BROWSER === 'firefox' ? 'firefox' : 'chromium';
}

/**
 * Starts the browser with the extension. `videos` maps 11-character video IDs to videoDetails fields
 * (lengthSeconds, isLive, isLiveContent), plus optional `chapters` for the page data. `sponsorblock` is
 * null for "no segments" (404) or a list of { videoID, segments } entries to answer every lookup with.
 */
export async function launch({ videos, sponsorblock = null }) {
  const browser = chosenBrowser();
  const backend =
    browser === 'firefox'
      ? await (await import('./browser-firefox.mjs')).launchFirefox({ repo, videos, sponsorblock })
      : await (await import('./browser-chromium.mjs')).launchChromium({ repo, videos, sponsorblock });
  console.log(`[${browser}]`);

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };
  const skip = (name, reason) => console.log(`SKIP ${name} - ${reason}`);

  return {
    ...backend,
    check,
    skip,
    sleep,
    waitFor,
    async finish() {
      await backend.close();
      const failed = results.filter((ok) => !ok).length;
      console.log(`\n${results.length - failed} passed, ${failed} failed`);
      return failed ? 1 : 0;
    },
  };
}
