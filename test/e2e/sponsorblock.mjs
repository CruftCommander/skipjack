// End to end: SponsorBlock skips and channel exclusions, with no API key, against the mock
// YouTube page. Run `npm run build` first. Usage: node test/e2e/sponsorblock.mjs [--firefox]
//
// Checks: a SponsorBlock sponsor is skipped with a toast not marked "(detected)", without touching
// captions or calling Anthropic; a creator chapter titled "Sponsor" is skipped with no key and
// labeled "(chapter)", while a YouTube auto-chapter is not; a channel excluded by handle on the
// settings page gets no lookup.

import { launch } from './harness.mjs';

const ids = ['sbvideo0001', 'sbvideo0002'];
const plain = { lengthSeconds: '120', isLive: false, isLiveContent: false };
const t = await launch({
  videos: {
    ...Object.fromEntries(ids.map((id) => [id, plain])),
    // Not in SponsorBlock's answer. The creator's "Sponsor" chapter runs 0:08 to 0:21; YouTube's
    // generated "Sponsor break" at 0:40 to 0:50 must not be skipped on its own.
    chvideo0001: {
      ...plain,
      chapters: {
        DESCRIPTION_CHAPTERS: [['Intro', 0], ['Sponsor', 8], ['Main', 21]],
        AUTO_CHAPTERS: [['Opening', 0], ['Sponsor break', 40], ['Story', 50]],
      },
    },
  },
  // A hash-prefix answer listing both videos; Skipjack picks its own.
  sponsorblock: ids.map((videoID) => ({ videoID, segments: [{ category: 'sponsor', actionType: 'skip', segment: [8, 21], UUID: `u-${videoID}` }] })),
});
const { calls, check, open, openSettings, sleep, waitFor } = t;
const toggles = (page) => page.evaluate(() => window.__toggles);
const currentTime = (page) => page.evaluate(() => document.querySelector('video').currentTime);

try {
  // 1. A SponsorBlock sponsor is skipped and labeled as SponsorBlock's.
  {
    const { page, logs } = await open('sbvideo0001');
    const skipped = await waitFor(() => logs.find((l) => /skipped sponsor/.test(l)), 30000);
    check('SponsorBlock: sponsor skipped', Boolean(skipped), skipped ?? logs.join(' | '));
    const time = await currentTime(page);
    check('SponsorBlock: playback is past the sponsor', time > 20, `currentTime ${time.toFixed(1)}`);
    const toast = (await page.allText()).match(/Skipped sponsor[^U]*/)?.[0] ?? '';
    check('SponsorBlock: toast shown, not marked detected', /Skipped sponsor \(0:1\d\)/.test(toast) && !/detected/.test(toast), toast);
    check('SponsorBlock: captions never toggled', (await toggles(page)) === 0);
    check('SponsorBlock: no Anthropic request', calls.anthropic === 0);
    await page.close();
  }

  // 2. A creator chapter titled "Sponsor" is skipped with no key; YouTube's auto-chapter is not.
  {
    const { page, logs } = await open('chvideo0001');
    const found = await waitFor(() => logs.find((l) => /sponsor segment\(s\) from the creator's chapter titles/.test(l)), 30000);
    check('chapter: one sponsor segment from the creator chapter', /: 1 sponsor segment/.test(found ?? ''), found ?? logs.join(' | '));
    const skipped = await waitFor(() => logs.find((l) => /skipped sponsor/.test(l)), 30000);
    check('chapter: sponsor skipped', /skipped sponsor 0:0\d -> 0:2\d/.test(skipped ?? ''), skipped ?? logs.join(' | '));
    const toast = (await page.allText()).match(/Skipped sponsor[^U]*/)?.[0] ?? '';
    check('chapter: toast says (chapter)', /Skipped sponsor \(chapter\)/.test(toast), toast);
    check('chapter: no Anthropic request', calls.anthropic === 0);
    await page.close();
  }

  // 3. Exclude the channel from the settings page by handle; its videos are not looked up.
  {
    const opts = await openSettings();
    await opts.fill('#channel-input', '@mockchannel');
    await opts.click('#channel-add');
    const status = await waitFor(() => opts.text('#channel-status'), 5000);
    check('settings: channel excluded', /Not skipping on @mockchannel/.test(status ?? ''), status);
    const keyStatus = await opts.text('#api-key-status-anthropic');
    check('settings: key status renders', /No Anthropic key saved/.test(keyStatus ?? ''), keyStatus);
    const openaiStatus = await opts.text('#api-key-status-openai');
    check('settings: a key row per provider', /No OpenAI key saved/.test(openaiStatus ?? ''), openaiStatus);
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
