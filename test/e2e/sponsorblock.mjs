// End to end: SponsorBlock skips and channel exclusions, with no API key, against the mock
// YouTube page. Run `npm run build` first. Usage: node test/e2e/sponsorblock.mjs [--firefox]
//
// Checks: a SponsorBlock sponsor is skipped with a toast not marked "(detected)", without touching
// captions or calling Anthropic; a creator chapter titled "Sponsor" is skipped with no key and
// labeled "(chapter)", while a YouTube auto-chapter is not; the diagnostic log records nothing while
// off, records the page's lines once turned on, downloads as a text file, and clears; a channel
// excluded by handle on the settings page gets no lookup.

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
const { calls, check, local, open, openSettings, sleep, waitFor } = t;
const LOG_KEY = 'diagnosticLog';
const logLines = async () => ((await local())[LOG_KEY] ?? []).map((e) => e.text);
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

  // 3. The diagnostic log: off by default, on from the settings page, downloaded, cleared, and off again.
  {
    check('log: nothing recorded while off', !(LOG_KEY in (await local())));

    const opts = await openSettings();
    await opts.click('input[name="diagnostics.log"]');
    const saved = await waitFor(async () => (/Saved/.test((await opts.text('#status')) ?? '') ? 'Saved' : null), 5000);
    check('log: turned on from the settings page', saved === 'Saved');
    check('log: settings page says none saved yet', /No log saved/.test((await opts.text('#log-summary')) ?? ''));

    const { page, logs } = await open('sbvideo0001');
    await waitFor(() => logs.find((l) => /skipped sponsor/.test(l)), 30000);
    const stored = await waitFor(async () => {
      const lines = await logLines();
      return lines.some((l) => /skipped sponsor/.test(l)) ? lines : null;
    }, 10000);
    check('log: the page\'s lines are stored', Boolean(stored), (stored ?? (await logLines())).join(' | '));
    check('log: startup line included', (stored ?? []).some((l) => /platform youtube/.test(l)));
    await page.close();

    const summary = await waitFor(async () => {
      const text = (await opts.text('#log-summary')) ?? '';
      return /line.* saved, from/.test(text) ? text : null;
    }, 5000);
    check('log: settings page shows the saved lines', Boolean(summary), summary ?? (await opts.text('#log-summary')));

    // Capture the download instead of saving it: keep the blob URL alive and record the link.
    await opts.evaluate(() => {
      URL.revokeObjectURL = () => undefined;
      HTMLAnchorElement.prototype.click = function () {
        window.__download = { name: this.download, href: this.href };
      };
      return true;
    });
    await opts.click('#log-download');
    const dl = await waitFor(() => opts.evaluate(() => window.__download ?? null), 5000);
    check('log: download named by date', /^skipjack-log-\d{4}-\d\d-\d\d-\d{4}\.txt$/.test(dl?.name ?? ''), dl?.name);
    const file = dl ? await opts.evaluate((href) => fetch(href).then((r) => r.text()), dl.href) : '';
    check('log: file has the header and the skip', /^# Skipjack \S+ diagnostic log/.test(file) && /Z INFO .*skipped sponsor/.test(file), file.slice(0, 300));

    await opts.click('#log-clear');
    const cleared = await waitFor(async () => {
      const text = (await opts.text('#log-status')) ?? '';
      return /Cleared \d+ line/.test(text) ? text : null;
    }, 5000);
    check('log: cleared from the settings page', Boolean(cleared) && !(LOG_KEY in (await local())), cleared ?? (await opts.text('#log-status')));

    await opts.click('input[name="diagnostics.log"]');
    const off = await waitFor(async () => (/Saved/.test((await opts.text('#status')) ?? '') ? 'Saved' : null), 5000);
    check('log: turned off from the settings page', off === 'Saved');
    const again = await open('sbvideo0001');
    await waitFor(() => again.logs.find((l) => /skipped sponsor/.test(l)), 30000);
    await sleep(2000);
    check('log: nothing recorded after turning it off', !(LOG_KEY in (await local())), (await logLines()).join(' | '));
    await again.page.close();
    await opts.close();
  }

  // 4. Exclude the channel from the settings page by handle; its videos are not looked up.
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
