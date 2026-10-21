// Shared harness for the end-to-end checks: launches Chromium with the built extension from
// dist/chromium, serves a mock YouTube watch page, and mocks SponsorBlock, the caption endpoint, and
// the Anthropic API. Nothing here reaches the real sites. See README.md in this folder.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Lets Playwright see the extension service worker's own requests, so they can be mocked.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, '..', '..');

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

/** Caption cues for a 2-minute video: a sponsor read from 0:08 to about 0:20, then filler. */
const lines = [
  [1, 'Welcome back to the channel.'],
  [8, 'This video is sponsored by Acme Widgets.'],
  [12, 'Acme Widgets make the best widgets around.'],
  [16, 'Use code SKIP for ten percent off.'],
  [20, 'Now, back to the video.'],
];
for (let t = 24; t < 118; t += 4) lines.push([t, `Filler line at ${t} seconds about the actual topic.`]);
const json3 = JSON.stringify({
  events: lines.map(([t, text], i) => ({ tStartMs: t * 1000, dDurationMs: ((lines[i + 1]?.[0] ?? 120) - t) * 1000, segs: [{ utf8: text }] })),
});

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
/** A streamed Messages API reply that reports the sponsor read on transcript lines 1 to 3. */
const anthropicBody = sse([
  { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 900, output_tokens: 1 } } },
  { type: 'ping' },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'report_segments', input: {} } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: JSON.stringify({
        segments: [{ category: 'sponsor', first_line: 1, first_words: 'This video is sponsored', last_line: 3, last_words: 'ten percent off.', confidence: 0.95 }],
      }),
    },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 900, output_tokens: 60 } },
  { type: 'message_stop' },
]);

/**
 * A watch page whose #movie_player answers getVideoData() and getPlayerResponse() like YouTube's,
 * with a captions button that, like the real player, requests the track with a token when switched on.
 */
function watchPage(id, details) {
  const response = {
    videoDetails: { videoId: id, channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', author: 'Mock Channel', title: `Mock ${id}`, shortDescription: 'Use code SKIP', ...details },
    microformat: { playerMicroformatRenderer: { ownerProfileUrl: 'http://www.youtube.com/@mockchannel' } },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: '/api/timedtext?v=' + id, languageCode: 'en', kind: 'asr' }] } },
  };
  return `<!doctype html><html><head><title>${id}</title></head><body>
<div id="movie_player" class="html5-video-player">
  <video class="html5-main-video" src="/test.webm" muted autoplay playsinline></video>
  <button class="ytp-subtitles-button" aria-pressed="false">CC</button>
  <div class="ytp-caption-window-container"></div>
</div>
<script>
  const p = document.getElementById('movie_player');
  const response = ${JSON.stringify(response)};
  p.getVideoData = () => ({ video_id: ${JSON.stringify(id)}, author: 'Mock Channel' });
  p.getPlayerResponse = () => response;
  const b = p.querySelector('.ytp-subtitles-button');
  window.__toggles = 0;
  b.addEventListener('click', () => {
    window.__toggles++;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    if (on) fetch('/api/timedtext?v=${id}&lang=en&kind=asr&pot=TOKEN&fmt=srv3&r=' + Math.random());
  });
</script></body></html>`;
}

/**
 * Starts Chromium with the extension. `videos` maps 11-character video IDs to videoDetails fields
 * (lengthSeconds, isLive, isLiveContent). `sponsorblock` is null for "no segments" (404) or a list
 * of { videoID, segments } entries to answer every lookup with.
 */
export async function launch({ videos, sponsorblock = null }) {
  const { chromium } = await loadPlaywright();
  const ext = join(repo, 'dist', 'chromium');
  const webm = await readFile(join(here, 'test.webm'));
  const profile = await mkdtemp(join(tmpdir(), 'skipjack-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.HEADED ? false : true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  });

  const calls = { anthropic: 0, sponsorblock: 0, captions: 0 };
  await ctx.route('https://sponsor.ajay.app/**', (r) => {
    calls.sponsorblock++;
    if (!sponsorblock) return r.fulfill({ status: 404, body: 'Not Found' });
    return r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(sponsorblock) });
  });
  await ctx.route('https://api.anthropic.com/**', (r) => {
    calls.anthropic++;
    return r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: anthropicBody });
  });
  await ctx.route('https://www.youtube.com/**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === '/test.webm') {
      // Without range support the video is not seekable, and every skip snaps back to the start.
      const m = /bytes=(\d+)-(\d*)/.exec(r.request().headers()['range'] ?? '');
      if (!m) return r.fulfill({ status: 200, headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes' }, body: webm });
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : webm.length - 1;
      return r.fulfill({
        status: 206,
        headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${webm.length}` },
        body: webm.subarray(start, end + 1),
      });
    }
    if (url.pathname === '/api/timedtext') {
      calls.captions++;
      return r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: json3 });
    }
    const id = url.searchParams.get('v');
    if (url.pathname === '/watch' && id && videos[id]) return r.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: watchPage(id, videos[id]) });
    return r.fulfill({ status: 404, body: '' });
  });

  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };

  return {
    ctx,
    sw,
    extId,
    calls,
    check,
    sleep,
    waitFor,
    /** Everything in the extension's local storage, read from the background script. */
    local: () => sw.evaluate(() => chrome.storage.local.get(null)),
    /** Opens a mock watch page and collects its [Skipjack] console lines. */
    async open(id) {
      const page = await ctx.newPage();
      const logs = [];
      page.on('console', (m) => {
        if (m.text().includes('[Skipjack]')) logs.push(m.text());
      });
      await page.goto(`https://www.youtube.com/watch?v=${id}`);
      return { page, logs };
    },
    /** All text on the page, including inside shadow roots, where the toast lives. */
    pageText: (page) =>
      page.evaluate(() => {
        const out = [];
        const walk = (root) => {
          out.push(root.textContent ?? '');
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
        };
        walk(document);
        return out.join(' ');
      }),
    /** Closes the browser, prints the tally, and returns the exit code. */
    async finish() {
      await ctx.close();
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      const failed = results.filter((ok) => !ok).length;
      console.log(`\n${results.length - failed} passed, ${failed} failed`);
      return failed ? 1 : 0;
    },
  };
}
