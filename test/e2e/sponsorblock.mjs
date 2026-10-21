// End to end: SponsorBlock skips and channel exclusions, with no API key, against the mock
// YouTube page. Run `npm run build` first. Usage: node test/e2e/sponsorblock.mjs
//
// Checks: a SponsorBlock sponsor is skipped with a toast not marked "(detected)", without touching
// captions or calling Anthropic; a channel excluded by handle on the settings page gets no lookup.

import { launch } from './harness.mjs';

const ids = ['sbvideo0001', 'sbvideo0002'];
const t = await launch({
  videos: Object.fromEntries(ids.map((id) => [id, { lengthSeconds: '120', isLive: false, isLiveContent: false }])),
  // A hash-prefix answer listing both videos; Skipjack picks its own.
  sponsorblock: ids.map((videoID) => ({ videoID, segments: [{ category: 'sponsor', actionType: 'skip', segment: [8, 21], UUID: `u-${videoID}` }] })),
});
const { calls, check, open, sleep, waitFor, ctx, extId, pageText } = t;

try {
  // 1. A SponsorBlock sponsor is skipped and labeled as SponsorBlock's.
  {
    const { page, logs } = await open('sbvideo0001');
    const skipped = await waitFor(() => logs.find((l) => /skipped sponsor/.test(l)), 30000);
    check('SponsorBlock: sponsor skipped', Boolean(skipped), skipped ?? logs.join(' | '));
    const time = await page.evaluate(() => document.querySelector('video').currentTime);
    check('SponsorBlock: playback is past the sponsor', time > 20, `currentTime ${time.toFixed(1)}`);
    const toast = (await pageText(page)).match(/Skipped sponsor[^U]*/)?.[0] ?? '';
    check('SponsorBlock: toast shown, not marked detected', /Skipped sponsor \(0:1\d\)/.test(toast) && !/detected/.test(toast), toast);
    check('SponsorBlock: captions never toggled', (await page.evaluate(() => window.__toggles)) === 0);
    check('SponsorBlock: no Anthropic request', calls.anthropic === 0);
    await page.close();
  }

  // 2. Exclude the channel from the settings page by handle; its videos are not looked up.
  {
    const opts = await ctx.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html`);
    await opts.fill('#channel-input', '@mockchannel');
    await opts.click('#channel-add');
    const status = await waitFor(async () => (await opts.locator('#channel-status').textContent()) || null, 5000);
    check('settings: channel excluded', /Not skipping on @mockchannel/.test(status ?? ''), status);
    const keyStatus = await opts.locator('#api-key-status').textContent();
    check('settings: key status renders', /No key saved/.test(keyStatus ?? ''), keyStatus);
    await opts.close();

    const before = calls.sponsorblock;
    const { page, logs } = await open('sbvideo0002');
    const held = await waitFor(() => logs.find((l) => /is excluded; not skipping/.test(l)), 15000);
    check('excluded channel: held back', Boolean(held), held ?? logs.join(' | '));
    await sleep(1500);
    check('excluded channel: no SponsorBlock lookup', calls.sponsorblock === before, `${calls.sponsorblock - before} new lookups`);
    await page.close();
  }
} catch (error) {
  check('no unexpected error', false, error instanceof Error ? error.stack : String(error));
}

process.exit(await t.finish());
