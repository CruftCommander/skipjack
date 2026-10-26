// The mock YouTube site and APIs the end-to-end checks run against, shared by both browser back ends.
// Nothing here reaches the real sites: the watch page, the caption endpoint, SponsorBlock, the Anthropic API,
// and the OpenAI API are all answered here. The Chromium back end serves these answers through Playwright's
// request routing; the Firefox back end serves them from a local TLS proxy. See README.md in this folder.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

/** A streamed Responses API reply with the same report, as OpenAI's API sends it. */
const openaiBody = sse([
  { type: 'response.created', response: { id: 'r1', model: 'gpt-6-luna', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'report_segments', arguments: '' } },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    item_id: 'fc1',
    delta: JSON.stringify({
      segments: [{ category: 'sponsor', first_line: 1, first_words: 'This video is sponsored', last_line: 3, last_words: 'ten percent off.', confidence: 0.95 }],
    }),
  },
  // The done event repeats the whole arguments string, as the real API does.
  {
    type: 'response.function_call_arguments.done',
    output_index: 0,
    item_id: 'fc1',
    arguments: JSON.stringify({
      segments: [{ category: 'sponsor', first_line: 1, first_words: 'This video is sponsored', last_line: 3, last_words: 'ten percent off.', confidence: 0.95 }],
    }),
  },
  { type: 'response.completed', response: { id: 'r1', model: 'gpt-6-luna', status: 'completed', usage: { input_tokens: 800, output_tokens: 50 } } },
]);

/**
 * A watch page whose #movie_player answers getVideoData() and getPlayerResponse() like YouTube's,
 * with a captions button that, like the real player, requests the track with a token when switched on.
 */
function watchPage(id, { chapters, ...details }) {
  // Chapter sets as YouTube's page data lists them: { DESCRIPTION_CHAPTERS: [[title, startSeconds]], AUTO_CHAPTERS: [...] }.
  const initialData = {
    currentVideoEndpoint: { watchEndpoint: { videoId: id } },
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                markersMap: Object.entries(chapters ?? {}).map(([key, list]) => ({
                  key,
                  value: { chapters: list.map(([title, start]) => ({ chapterRenderer: { title: { simpleText: title }, timeRangeStartMillis: start * 1000 } })) },
                })),
              },
            },
          },
        },
      },
    },
  };
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
  window.ytInitialData = ${JSON.stringify(initialData)};
  p.getVideoData = () => ({ video_id: ${JSON.stringify(id)}, author: 'Mock Channel' });
  p.getPlayerResponse = () => response;
  const b = p.querySelector('.ytp-subtitles-button');
  window.__toggles = 0;
  b.addEventListener('click', () => {
    window.__toggles++;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    if (on) fetch('/api/timedtext?v=${id}&lang=en&kind=asr&pot=TOKEN&fmt=srv3&r=' + Math.random());
    // Like the step 1 probe: another script fetches the track without the player's token, just after it.
    if (on) setTimeout(() => fetch('/api/timedtext?v=${id}&lang=en&kind=asr'), 50);
  });
</script></body></html>`;
}

/**
 * The mock site. `videos` maps 11-character video IDs to videoDetails fields (lengthSeconds, isLive,
 * isLiveContent), plus optional `chapters` for the page data. `sponsorblock` is null for "no segments"
 * (404) or a list of { videoID, segments } entries to answer every lookup with. `calls` counts the
 * requests each API receives: anthropic, openai, sponsorblock, captions.
 */
export async function createMockSite({ videos, sponsorblock = null }) {
  const webm = await readFile(join(here, 'test.webm'));
  const calls = { anthropic: 0, openai: 0, sponsorblock: 0, captions: 0 };

  /**
   * Answers one request: { status, headers, body }. `url` is the full URL and `range` the Range
   * header, if any. Unknown hosts (Firefox's own services, say) get a 404 and are not counted.
   */
  function respond(url, range = '') {
    const u = new URL(url);
    if (u.host === 'sponsor.ajay.app') {
      calls.sponsorblock++;
      if (!sponsorblock) return { status: 404, headers: {}, body: 'Not Found' };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(sponsorblock) };
    }
    if (u.host === 'api.anthropic.com') {
      calls.anthropic++;
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: anthropicBody };
    }
    if (u.host === 'api.openai.com') {
      calls.openai++;
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: openaiBody };
    }
    if (u.host === 'www.youtube.com') {
      if (u.pathname === '/test.webm') {
        // Without range support the video is not seekable, and every skip snaps back to the start.
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (!m) return { status: 200, headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes' }, body: webm };
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : webm.length - 1;
        return {
          status: 206,
          headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${webm.length}` },
          body: webm.subarray(start, end + 1),
        };
      }
      if (u.pathname === '/api/timedtext') {
        calls.captions++;
        // As on YouTube: a caption request without the player's proof-of-origin token gets an empty 200.
        return { status: 200, headers: { 'content-type': 'application/json' }, body: u.searchParams.get('pot') ? json3 : '' };
      }
      const id = u.searchParams.get('v');
      if (u.pathname === '/watch' && id && videos[id]) return { status: 200, headers: { 'content-type': 'text/html' }, body: watchPage(id, videos[id]) };
    }
    return { status: 404, headers: {}, body: '' };
  }

  return { calls, respond };
}
