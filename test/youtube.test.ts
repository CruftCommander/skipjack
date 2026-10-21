import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTime } from '../src/core/format';
import { isDetectRequest, MAX_CUES, MAX_DURATION_SECONDS } from '../src/core/messages';
import { playerMediaLength, shouldRestoreCaptions, toResult, TRANSCRIPT_MESSAGE_SOURCE, type TranscriptReply, youtubeMediaIdFromUrl } from '../src/platforms/youtube';

const id = (u: string) => youtubeMediaIdFromUrl(new URL(u));

test('watch and live pages yield the video ID', () => {
  assert.equal(id('https://www.youtube.com/watch?v=wIe3eDfGKUo'), 'wIe3eDfGKUo');
  assert.equal(id('https://www.youtube.com/watch?v=lrbbhhaboy0&t=3227s&list=PL1'), 'lrbbhhaboy0');
  assert.equal(id('https://m.youtube.com/watch?v=4kYyd_hoqUw'), '4kYyd_hoqUw');
  assert.equal(id('https://www.youtube.com/live/5k_YlkT1bjc?feature=share'), '5k_YlkT1bjc');
});

test('other pages, Shorts, other hosts, and malformed IDs yield nothing', () => {
  assert.equal(id('https://www.youtube.com/'), null);
  assert.equal(id('https://www.youtube.com/results?search_query=x'), null);
  assert.equal(id('https://www.youtube.com/shorts/wIe3eDfGKUo'), null);
  assert.equal(id('https://www.youtube.com/watch?v=short'), null);
  assert.equal(id('https://www.youtube.com/watch?v=wIe3eDfGKUo%22'), null);
  assert.equal(id('https://music.youtube.com/watch?v=wIe3eDfGKUo'), null);
  assert.equal(id('https://example.com/watch?v=wIe3eDfGKUo'), null);
});

test('a finished live stream recording has a length and is analyzed', () => {
  // Regression: isLiveContent stays true on the recording of a stream, and was read as "live now",
  // so recordings were never analyzed.
  const recording = { lengthSeconds: '5432', isLive: false, isLiveContent: true };
  const recordingNoIsLive = { lengthSeconds: '5432', isLiveContent: true };
  assert.equal(playerMediaLength(recording), 5432);
  assert.equal(playerMediaLength(recordingNoIsLive), 5432);
  assert.equal(playerMediaLength({ lengthSeconds: '754' }), 754);
});

test('a stream that is live now, or one with no usable length, counts as live', () => {
  assert.equal(playerMediaLength({ lengthSeconds: '0', isLive: true }), 0);
  assert.equal(playerMediaLength({ lengthSeconds: '5432', isLive: true }), 0);
  assert.equal(playerMediaLength({ lengthSeconds: '0' }), 0);
  assert.equal(playerMediaLength({}), 0);
  assert.equal(playerMediaLength({ lengthSeconds: '' }), 0);
  assert.equal(playerMediaLength({ lengthSeconds: 'abc' }), 0);
  assert.equal(playerMediaLength({ lengthSeconds: '-5' }), 0);
  assert.equal(playerMediaLength(undefined), 0);
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(88.4), '1:28');
  assert.equal(formatTime(3256), '54:16');
  assert.equal(formatTime(12339), '3:25:39');
  assert.equal(formatTime(Number.NaN), '0:00');
});

// What the page hands over, after toResult, must always pass the background's checks: a transcript
// the background refuses would cost a caption toggle and then fail with nothing to show for it.

function reply(overrides: Partial<Extract<TranscriptReply, { ok: true }>> = {}): TranscriptReply {
  return {
    source: TRANSCRIPT_MESSAGE_SOURCE,
    nonce: 'n',
    ok: true,
    videoId: 'wIe3eDfGKUo',
    title: 'T'.repeat(5000),
    lengthSeconds: 6 * 3600,
    cues: Array.from({ length: 3000 }, (_, i) => [i * 7, 9999, 'w'.repeat(1500)] as [number, number, string]),
    chapters: Array.from({ length: 150 }, (_, i) => ({ title: 'c'.repeat(3000), start: i * 60 })),
    paidPromotion: true,
    promoLines: Array(20).fill('use code X '.repeat(100)),
    track: { lang: 'en', kind: 'asr' },
    ...overrides,
  };
}

const roundTrip = (r: TranscriptReply) => {
  const result = toResult(r, 'wIe3eDfGKUo');
  return result.ok ? isDetectRequest({ type: 'detect', model: 'claude-sonnet-5-5', input: result.input }) : null;
};

test('a transcript the page hands over within limits always passes the background checks', () => {
  // Long cue text and durations, oversized titles, chapters, and promo lines are trimmed to fit.
  assert.equal(roundTrip(reply({ cues: Array.from({ length: 200 }, (_, i) => [i * 7, 9999, 'w'.repeat(1500)]) })), true);
  // The most cues allowed, each short.
  assert.equal(roundTrip(reply({ cues: Array.from({ length: MAX_CUES }, (_, i) => [i, 1, 'word']) })), true);
  // Cues past the end and chapters past the end are dropped, not sent.
  assert.equal(roundTrip(reply({ lengthSeconds: 600, cues: [[1, 2, 'a'], [5000, 1, 'b']], chapters: [{ title: 'x', start: 900 }] })), true);
});

test('toResult refuses what the background would, instead of sending it', () => {
  // Over the total character limit (3,000 cues of 1,000 characters).
  assert.equal(roundTrip(reply()), null);
  assert.equal(roundTrip(reply({ cues: Array.from({ length: MAX_CUES + 1 }, (_, i) => [i, 1, 'w']) })), null);
  // Regression: longer than the background's 48-hour bound was sent and refused there.
  assert.equal(roundTrip(reply({ lengthSeconds: MAX_DURATION_SECONDS + 1, cues: [[1, 1, 'a']] })), null);
  assert.equal(roundTrip(reply({ lengthSeconds: MAX_DURATION_SECONDS, cues: [[1, 1, 'a']] })), true);
});

test('captions are switched back only if they are still where Skipjack left them', () => {
  // Off before; Skipjack turned them on; still on: switch back off.
  assert.equal(shouldRestoreCaptions({ wasOn: false, leftOn: true, nowOn: true, viewerTouched: false }), true);
  // The viewer turned them off again meanwhile: nothing to do.
  assert.equal(shouldRestoreCaptions({ wasOn: false, leftOn: true, nowOn: false, viewerTouched: false }), false);
  // The viewer turned them off and on again: their choice (on) stands.
  assert.equal(shouldRestoreCaptions({ wasOn: false, leftOn: true, nowOn: true, viewerTouched: true }), false);
  // Regression: Skipjack's click did not take, and the viewer turned captions on. Leave them on.
  assert.equal(shouldRestoreCaptions({ wasOn: false, leftOn: false, nowOn: true, viewerTouched: false }), false);
  // On before; Skipjack cycled them and left them on: nothing to restore.
  assert.equal(shouldRestoreCaptions({ wasOn: true, leftOn: true, nowOn: true, viewerTouched: false }), false);
  assert.equal(shouldRestoreCaptions({ wasOn: true, leftOn: true, nowOn: false, viewerTouched: false }), false);
});
