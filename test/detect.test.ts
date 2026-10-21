import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUserMessage, SYSTEM_PROMPT, TOOL } from '../src/detect/prompt';
import { parseToolInput, refine } from '../src/detect/postprocess';
import { ANTHROPIC_URL, buildRequest, createAnthropicProvider } from '../src/llm/anthropic';
import type { DetectionInput } from '../src/llm/provider';
import { reportToInput } from '../eval/report';
import { scoreVideo } from '../eval/score';

const input: DetectionInput = {
  media: { platform: 'youtube', id: 'wIe3eDfGKUo' },
  title: 'Has AI Solved Reverse Engineering?',
  durationSeconds: 815,
  transcript: [
    { start: 222.4, duration: 3.6, text: 'has some functionality. Today\'s video\nis brought to you by Sentry' },
    { start: 310.1, duration: 4, text: 'Let\'s get back to it.' },
    { start: 314.2, duration: 3, text: '   ' },
  ],
  signals: { chapters: [{ title: 'Sponsor', start: 420 }], paidPromotion: false, descriptionPromoLines: ['20% off'] },
};

test('the user message carries metadata, signals, and one line per non-empty cue', () => {
  const m = buildUserMessage(input);
  assert.match(m, /^Title: Has AI Solved/);
  assert.match(m, /Duration: 815\.0 seconds \(13:35\)/);
  assert.match(m, /- 420\.0: Sponsor/);
  assert.match(m, /Paid-promotion flag: not set/);
  assert.match(m, /- 20% off/);
  assert.match(m, /\[222\.4\] has some functionality\. Today's video is brought to you by Sentry/);
  assert.equal(m.match(/^\[/gm)?.length, 2);
});

test('the request forces the tool and the prompt names it', () => {
  const r = buildRequest(input, 'claude-haiku-5-5');
  assert.deepEqual(r.tool_choice, { type: 'tool', name: TOOL.name });
  assert.ok(SYSTEM_PROMPT.includes(TOOL.name));
  assert.equal(r.model, 'claude-haiku-5-5');
});

test('parseToolInput keeps valid segments and clamps confidence', () => {
  const out = parseToolInput({
    segments: [
      { category: 'sponsor', start_seconds: 226, end_seconds: 314, confidence: 1.4, first_words: "Today's video", last_words: 'back to it.' },
      { category: 'music', start_seconds: 1, end_seconds: 2, confidence: 1 },
      { category: 'interaction', start_seconds: 'x', end_seconds: 2, confidence: 1 },
      null,
    ],
  });
  assert.deepEqual(out, [{ category: 'sponsor', start: 226, end: 314, confidence: 1, firstWords: "Today's video", lastWords: 'back to it.' }]);
  assert.throws(() => parseToolInput({}), /no segments array/);
});

test('refine snaps outward to chapter marks and the video end, never inward', () => {
  const chapters = [{ title: 'Sponsor', start: 420 }, { title: 'Phenomena', start: 520 }];
  const [a] = refine([{ category: 'sponsor', start: 421.5, end: 518.2, confidence: 1 }], 1470, chapters);
  assert.deepEqual([a?.start, a?.end], [420, 520]);
  // A chapter mark inside the segment never pulls a boundary inward.
  const [b] = refine([{ category: 'sponsor', start: 418, end: 522, confidence: 1 }], 1470, chapters);
  assert.deepEqual([b?.start, b?.end], [418, 522]);
  const [c] = refine([{ category: 'interaction', start: 3227, end: 3254, confidence: 1 }], 3256, []);
  assert.equal(c?.end, 3256);
});

test('refine clamps, drops empty and tiny segments, and sorts', () => {
  const out = refine(
    [
      { category: 'sponsor', start: 50, end: 900, confidence: 1 },
      { category: 'interaction', start: -2, end: 6, confidence: 1 },
      { category: 'selfpromo', start: 30, end: 30.5, confidence: 1 },
      { category: 'selfpromo', start: 40, end: 39, confidence: 1 },
    ],
    815,
  );
  assert.deepEqual(out.map((s) => [s.start, s.end]), [[0, 6], [50, 815]]);
});

test('the provider calls the Messages API with the BYOK headers and parses the tool call', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const provider = createAnthropicProvider(async (url, init) => {
    seen = { url, init: init ?? {} };
    return new Response(
      JSON.stringify({
        model: 'claude-haiku-5-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: TOOL.name, input: { segments: [{ category: 'sponsor', start_seconds: 226, end_seconds: 314, confidence: 0.9, first_words: 'a', last_words: 'b' }] } }],
        usage: { input_tokens: 1200, output_tokens: 80 },
      }),
      { status: 200 },
    );
  });
  const r = await provider.detect(input, { apiKey: 'sk-test', model: 'claude-haiku-5-5' });
  assert.equal(seen!.url, ANTHROPIC_URL);
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 80 });
  assert.deepEqual(r.segments.map((s) => [s.category, s.start, s.end]), [['sponsor', 226, 314]]);
});

test('the provider reports API errors and missing tool calls', async () => {
  const err = createAnthropicProvider(async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }));
  await assert.rejects(err.detect(input, { apiKey: 'bad', model: 'm' }), /Anthropic: invalid x-api-key/);
  const none = createAnthropicProvider(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }), { status: 200 }));
  await assert.rejects(none.detect(input, { apiKey: 'k', model: 'm' }), /no report_segments call/);
});

test('reportToInput reads a probe report', () => {
  const i = reportToInput({
    videoId: 'abc',
    title: 'T',
    lengthSeconds: 100,
    chapters: { items: [{ title: 'Sponsor', startMs: 7000 }] },
    paidPromotion: { flag: true },
    description: { promoLines: ['code X'] },
    transcript: { cues: [[1500, 2000, 'hello']] },
  });
  assert.deepEqual(i.transcript, [{ start: 1.5, duration: 2, text: 'hello' }]);
  assert.deepEqual(i.signals, { chapters: [{ title: 'Sponsor', start: 7 }], descriptionPromoLines: ['code X'], paidPromotion: true });
  assert.throws(() => reportToInput({ videoId: 'x' }), /no transcript/);
});

test('scoreVideo measures pitch shown and content lost per boundary', () => {
  const s = scoreVideo(
    [{ category: 'sponsor', start: 420, end: 521 }, { category: 'interaction', start: 13, end: 38 }],
    [{ category: 'sponsor', start: 419, end: 520 }, { category: 'selfpromo', start: 14, end: 37 }, { category: 'sponsor', start: 900, end: 950 }],
  );
  const m = s.matches[0]!;
  assert.deepEqual([m.start.contentLost, m.start.pitchShown, m.start.pass], [1, 0, true]);
  assert.deepEqual([m.end.pitchShown, m.end.pass], [1, true]);
  assert.equal(s.missed.length, 1);
  assert.equal(s.wrongCategory[0]?.detected.category, 'selfpromo');
  assert.equal(s.falsePositives.length, 2);
});
