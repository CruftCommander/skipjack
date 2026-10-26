// End to end: transcript detection with an API key, against the mock YouTube page.
// Run `npm run build` first. Usage: node test/e2e/detect.mjs
//
// Checks: with no key nothing is toggled or sent; a past live stream's recording (isLiveContent
// true, isLive false) is analyzed and its sponsor skipped with the "(detected)" toast; captions are
// switched back; content scripts cannot read local storage; the second visit is cached; a stream
// that is live now is not analyzed and the log says why; the settings page shows the last detection, and Clear detection
// cache removes results and status but keeps the key; after clearing, the video is analyzed again.

import { launch } from './harness.mjs';

const t = await launch({
  videos: {
    rec00000001: { lengthSeconds: '120', isLive: false, isLiveContent: true },
    live0000001: { lengthSeconds: '0', isLive: true, isLiveContent: true },
    nokey000001: { lengthSeconds: '120', isLive: false, isLiveContent: false },
  },
});
const { calls, check, open, sleep, waitFor, local, sw, ctx, extId, pageText } = t;
const toggles = (page) => page.evaluate(() => window.__toggles);

try {
  // 1. No key: nothing toggled, nothing sent.
  {
    const { page, logs } = await open('nokey000001');
    await waitFor(() => logs.some((l) => /no API key set/.test(l)), 15000);
    check('no key: logs that detection is off', logs.some((l) => /no API key set/.test(l)), logs.at(-1));
    check('no key: captions never toggled', (await toggles(page)) === 0);
    check('no key: no Anthropic request', calls.anthropic === 0);
    await page.close();
  }

  await sw.evaluate(() => chrome.storage.local.set({ 'apiKey:anthropic': 'sk-ant-test-0123456789abcdefghijklmnop' }));

  // 2. A finished live stream's recording is analyzed and its sponsor skipped.
  {
    const { page, logs } = await open('rec00000001');
    const skipped = await waitFor(() => logs.find((l) => /skipped sponsor/.test(l)), 40000);
    check('recording of a past stream: detection ran', calls.anthropic === 1, `anthropic calls ${calls.anthropic}`);
    check('recording: sponsor skipped', Boolean(skipped), skipped ?? logs.join(' | '));
    const time = await page.evaluate(() => document.querySelector('video').currentTime);
    check('recording: playback is past the sponsor', time > 19, `currentTime ${time.toFixed(1)}`);
    const toast = (await pageText(page)).match(/Skipped[^U]*/)?.[0];
    check('recording: toast says (detected)', /Skipped sponsor \(detected\)/.test(toast ?? ''), toast);
    check('recording: captions switched back off', (await page.evaluate(() => document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed'))) === 'false');
    const st = (await local()).detectionStatus;
    check('recording: status recorded ok', st?.ok === true && /1 segment/.test(st.message), JSON.stringify(st));

    // Content scripts can't read local storage, where the key lives, but still read synced settings.
    const cdp = await ctx.newCDPSession(page);
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
    await cdp.send('Runtime.enable');
    await sleep(300);
    const isolated = contexts.find((c) => c.auxData?.type === 'isolated' && /Skipjack/.test(c.name));
    if (!isolated) check('content script context found', false, JSON.stringify(contexts.map((c) => [c.name, c.auxData?.type])));
    else {
      const ev = (expression) => cdp.send('Runtime.evaluate', { expression, contextId: isolated.id, awaitPromise: true, returnByValue: true });
      const localRead = await ev(`chrome.storage.local.get(null).then(() => 'readable', (e) => 'blocked: ' + e.message)`);
      check('content script cannot read local storage', /^blocked/.test(localRead.result.value), localRead.result.value);
      const syncRead = await ev(`chrome.storage.sync.get(null).then(() => 'readable', (e) => 'blocked: ' + e.message)`);
      check('content script can still read synced settings', syncRead.result.value === 'readable', syncRead.result.value);
    }
    await page.close();
  }

  // 3. Second visit: cached, no new request, no captions toggle.
  {
    const { page, logs } = await open('rec00000001');
    const cached = await waitFor(() => logs.find((l) => /\(cached\)/.test(l)), 20000);
    check('second visit uses the cache', Boolean(cached) && calls.anthropic === 1, `${cached ?? logs.join(' | ')}; anthropic calls ${calls.anthropic}`);
    check('second visit: captions never toggled', (await toggles(page)) === 0);
    await page.close();
  }

  // 4. A stream that is live now is not analyzed.
  {
    const before = calls.anthropic;
    const { page, logs } = await open('live0000001');
    await sleep(6000);
    check('live now: no detection', calls.anthropic === before, logs.join(' | '));
    check('live now: captions never toggled', (await toggles(page)) === 0);
    check('live now: logs why', logs.some((l) => l.includes('no transcript detection: live streams are not analyzed')), logs.join(' | '));
    await page.close();
  }

  // 5. Settings page: last detection shown; Clear detection cache removes results and status only.
  {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    const last = await waitFor(() => page.locator('#detection-last').textContent(), 5000);
    check('settings: last detection shown', /Last detection/.test(last ?? ''), last);
    await page.click('#detection-clear');
    const msg = await waitFor(async () => (await page.locator('#detection-clear-status').textContent()) || null, 5000);
    check('settings: clear reports one video', /Cleared saved results for 1 video\./.test(msg ?? ''), msg);
    const after = await local();
    const keys = Object.keys(after);
    check('settings: no det: entries or status left', !keys.some((k) => k.startsWith('det:')) && !('detectionStatus' in after), keys.join(','));
    check('settings: API key and budget kept', 'apiKey:anthropic' in after && 'detectionBudget' in after, keys.join(','));
    const lastAfter = await page.locator('#detection-last').textContent();
    check('settings: last detection line cleared', !lastAfter, lastAfter);
    await page.click('#detection-clear');
    const again = await waitFor(async () => {
      const text = await page.locator('#detection-clear-status').textContent();
      return /already empty/.test(text ?? '') ? text : null;
    }, 5000);
    check('settings: second clear says already empty', Boolean(again), again);
    await page.close();
  }

  // 6. After clearing, the video is analyzed again.
  {
    const before = calls.anthropic;
    const { page, logs } = await open('rec00000001');
    await waitFor(() => calls.anthropic > before, 30000);
    check('after clearing, the video is detected again', calls.anthropic === before + 1, logs.join(' | '));
    await page.close();
  }
} catch (error) {
  check('no unexpected error', false, error instanceof Error ? error.stack : String(error));
}

process.exit(await t.finish());
