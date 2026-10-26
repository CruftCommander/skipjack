// End to end: transcript detection with an API key, against the mock YouTube page.
// Run `npm run build` first. Usage: node test/e2e/detect.mjs [--firefox]
//
// Checks: with no key nothing is toggled or sent; a past live stream's recording (isLiveContent
// true, isLive false) is analyzed and its sponsor skipped with the "(detected)" toast; captions are
// switched back; content scripts cannot read local storage (Chromium; Firefox has no such control);
// the second visit is cached; a stream that is live now is not analyzed and the log says why; the
// settings page shows the last detection, and Clear detection cache removes results and status but
// keeps the key; after clearing, the video is analyzed again; an OpenAI model with an OpenAI key is
// served by OpenAI, and the settings page shows a key row per provider.

import { launch } from './harness.mjs';

const t = await launch({
  videos: {
    rec00000001: { lengthSeconds: '120', isLive: false, isLiveContent: true },
    live0000001: { lengthSeconds: '0', isLive: true, isLiveContent: true },
    nokey000001: { lengthSeconds: '120', isLive: false, isLiveContent: false },
    oai00000001: { lengthSeconds: '120', isLive: false, isLiveContent: false },
  },
});
const { calls, check, skip, open, openSettings, sleep, waitFor, local, setLocal } = t;
const toggles = (page) => page.evaluate(() => window.__toggles);
const currentTime = (page) => page.evaluate(() => document.querySelector('video').currentTime);
const captionsPressed = (page) => page.evaluate(() => document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed'));

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

  await setLocal({ 'apiKey:anthropic': 'sk-ant-test-0123456789abcdefghijklmnop' });

  // 2. A finished live stream's recording is analyzed and its sponsor skipped.
  {
    const { page, logs } = await open('rec00000001');
    const skipped = await waitFor(() => logs.find((l) => /skipped sponsor/.test(l)), 40000);
    check('recording of a past stream: detection ran', calls.anthropic === 1, `anthropic calls ${calls.anthropic}`);
    check('recording: sponsor skipped', Boolean(skipped), skipped ?? logs.join(' | '));
    const time = await currentTime(page);
    check('recording: playback is past the sponsor', time > 19, `currentTime ${time.toFixed(1)}`);
    const toast = (await page.allText()).match(/Skipped[^U]*/)?.[0];
    check('recording: toast says (detected)', /Skipped sponsor \(detected\)/.test(toast ?? ''), toast);
    check('recording: captions switched back off', (await captionsPressed(page)) === 'false');
    const st = (await local()).detectionStatus;
    check('recording: status recorded ok', st?.ok === true && /1 segment/.test(st.message), JSON.stringify(st));

    // Content scripts can't read local storage, where the key lives, but still read synced settings.
    if (page.contentScriptStorage) {
      const access = await page.contentScriptStorage();
      check('content script cannot read local storage', /^blocked/.test(access.local), access.local);
      check('content script can still read synced settings', access.sync === 'readable', access.sync);
    } else {
      skip('content script cannot read local storage', `${t.browser} has no storage access levels`);
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
    const page = await openSettings();
    const last = await waitFor(() => page.text('#detection-last'), 5000);
    check('settings: last detection shown', /Last detection/.test(last ?? ''), last);
    await page.click('#detection-clear');
    const msg = await waitFor(() => page.text('#detection-clear-status'), 5000);
    check('settings: clear reports one video', /Cleared saved results for 1 video\./.test(msg ?? ''), msg);
    const after = await local();
    const keys = Object.keys(after);
    check('settings: no det: entries or status left', !keys.some((k) => k.startsWith('det:')) && !('detectionStatus' in after), keys.join(','));
    check('settings: API key and budget kept', 'apiKey:anthropic' in after && 'detectionBudget' in after, keys.join(','));
    const lastAfter = await page.text('#detection-last');
    check('settings: last detection line cleared', !lastAfter, lastAfter);
    await page.click('#detection-clear');
    const again = await waitFor(async () => {
      const text = await page.text('#detection-clear-status');
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
  // 7. An OpenAI model, with an OpenAI key, is served by OpenAI.
  {
    await setLocal({ 'apiKey:openai': 'sk-proj-test-0123456789abcdefghijklmnop' });
    const settings = await openSettings();
    const picked = await settings.evaluate(() => {
      const select = document.querySelector('#model');
      select.value = 'gpt-6-luna';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    });
    check('settings: OpenAI model offered', picked === 'gpt-6-luna', picked);
    const saved = await waitFor(async () => {
      const text = await settings.text('#status');
      return text ? text : null;
    }, 5000);
    check('settings: model change saved', Boolean(saved), saved);
    const keyStatus = await settings.text('#api-key-status-openai');
    check('settings: OpenAI key shown', /OpenAI key ending in mnop/.test(keyStatus ?? ''), keyStatus);
    await settings.close();

    const before = { anthropic: calls.anthropic, openai: calls.openai };
    const { page, logs } = await open('oai00000001');
    const skipped = await waitFor(() => logs.find((l) => /skipped sponsor/.test(l)), 40000);
    check('OpenAI model: request went to OpenAI only', calls.openai === before.openai + 1 && calls.anthropic === before.anthropic, `openai ${calls.openai - before.openai}, anthropic ${calls.anthropic - before.anthropic}`);
    check('OpenAI model: detection logged with the model', logs.some((l) => /detecting with gpt-6-luna/.test(l)), logs.join(' | '));
    check('OpenAI model: sponsor skipped', Boolean(skipped), skipped ?? logs.join(' | '));
    const toast = (await page.allText()).match(/Skipped[^U]*/)?.[0];
    check('OpenAI model: toast says (detected)', /Skipped sponsor \(detected\)/.test(toast ?? ''), toast);
    const st = (await local()).detectionStatus;
    check('OpenAI model: status names the model', st?.ok === true && /gpt-6-luna/.test(st.message), JSON.stringify(st));
    await page.close();
  }
} catch (error) {
  check('no unexpected error', false, error instanceof Error ? error.stack : String(error));
}

process.exit(await t.finish());
