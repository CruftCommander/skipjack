import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUserMessage, SYSTEM_PROMPT, TOOL, transcriptLines } from '../src/detect/prompt';
import { parseToolInput, quotePosition, refine, toTimed } from '../src/detect/postprocess';
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
  assert.match(m, /^L0 \[222\.4\] has some functionality\. Today's video is brought to you by Sentry$/m);
  assert.match(m, /^L1 \[310\.1\] Let's get back to it\.$/m);
  assert.equal(m.match(/^L\d+ /gm)?.length, 2);
});

test('the request forces the tool and the prompt names it', () => {
  const r = buildRequest(input, 'claude-haiku-5-5');
  assert.deepEqual(r.tool_choice, { type: 'tool', name: TOOL.name });
  assert.ok(SYSTEM_PROMPT.includes(TOOL.name));
  assert.equal(r.model, 'claude-haiku-5-5');
});

test('parseToolInput keeps valid line-based reports and clamps confidence', () => {
  const out = parseToolInput({
    segments: [
      { category: 'sponsor', first_line: 3, first_words: "Today's video", last_line: 9, last_words: 'back to it.', confidence: 1.4 },
      { category: 'music', first_line: 1, last_line: 2, confidence: 1 },
      { category: 'interaction', first_line: 'x', last_line: 2, confidence: 1 },
      { category: 'interaction', first_line: 1.5, last_line: 2, confidence: 1 },
      null,
    ],
  });
  assert.deepEqual(out, [{ category: 'sponsor', firstLine: 3, lastLine: 9, firstWords: "Today's video", lastWords: 'back to it.', confidence: 1 }]);
  assert.throws(() => parseToolInput({}), /no segments array/);
});

test('transcriptLines numbers non-empty cues and gives each the next line start as its end', () => {
  const lines = transcriptLines(input);
  assert.deepEqual(lines.map((l) => [l.start, l.next]), [[222.4, 310.1], [310.1, 314.1]]);
});

test('quotePosition finds where a quote starts or ends inside a line, widened by one word', () => {
  const line = "has some functionality. Today's video is brought to you by Sentry";
  assert.equal(quotePosition(line, "Today's video is brought", 'start'), 2 / 11);
  assert.equal(quotePosition(line, 'brought to you by Sentry', 'end'), 1);
  assert.equal(quotePosition(line, 'has some functionality', 'end'), 4 / 11);
  // A quote that runs past the line still matches on its first or last words.
  assert.equal(quotePosition(line, 'by Sentry. Sentry is the', 'start'), 8 / 11);
  assert.equal(quotePosition(line, 'not in this line', 'start'), null);
  // A single repeated word is ambiguous, so it does not count.
  assert.equal(quotePosition('the cat and the dog', 'the', 'start'), null);
});

// The first eval (2026-10-21) showed models giving the start of the last pitch line as the end.
// Line-based reports put the end where the pitch's last words end instead.
test('toTimed ends a segment where its last words end, not where the last line starts', () => {
  const lines = [
    { start: 158, next: 159.1, text: 'longer than they\'ve been paying me to' },
    { start: 159.1, next: 161.2, text: 'talk about them. If you wanted to give' },
    { start: 161.2, next: 162.6, text: 'discount code down below. Let\'s get back' },
    { start: 162.6, next: 166.7, text: 'to the video.' },
    { start: 166.7, next: 169.1, text: 'Our story begins on January 5th, 1914' },
  ];
  const [seg] = toTimed([{ category: 'sponsor', firstLine: 0, lastLine: 3, lastWords: "Let's get back to the video.", confidence: 1 }], lines);
  assert.equal(seg?.start, 158);
  assert.equal(seg?.end, 166.7);
});

test('toTimed places a mid-line start by word position, and falls back outward when the quote is missing', () => {
  const lines = transcriptLines(input);
  const [a] = toTimed([{ category: 'sponsor', firstLine: 0, lastLine: 1, firstWords: "Today's video is", lastWords: 'get back to it.', confidence: 1 }], lines);
  assert.ok(a && Math.abs(a.start - (222.4 + (2 / 11) * 87.7)) < 1e-9);
  assert.equal(a?.end, 314.1);
  const [b] = toTimed([{ category: 'sponsor', firstLine: 0, lastLine: 1, firstWords: 'zzz', lastWords: 'zzz', confidence: 1 }], lines);
  assert.deepEqual([b?.start, b?.end], [222.4, 314.1]);
  assert.deepEqual(toTimed([{ category: 'sponsor', firstLine: 0, lastLine: 99, confidence: 1 }], lines), []);
});

// yGsVo0uIJVs, second eval: the model quoted the right last words but named the line after them.
test('toTimed finds a quote in a neighboring line when the stated line does not have it', () => {
  const lines = [
    { start: 580, next: 581.6, text: 'subscription the link is in the' },
    { start: 581.6, next: 583.6, text: 'description by checking out brilliant' },
    { start: 583.6, next: 589, text: 'you directly support our' },
    { start: 589, next: 593.2, text: '[Music]' },
    { start: 593.2, next: 597.2, text: "channel it's the summer of 1974 6 years" },
  ];
  const [seg] = toTimed([{ category: 'sponsor', firstLine: 0, lastLine: 4, lastWords: 'you directly support our', confidence: 1 }], lines);
  assert.equal(seg?.end, 589);
});

test('refine keeps a segment nested inside one of another category, and the eval does not count it as extra', () => {
  // wIe3eDfGKUo, second eval: a reminder inside the sponsor read.
  const out = refine(
    [
      { category: 'sponsor', start: 225.4, end: 313.7, confidence: 1 },
      { category: 'interaction', start: 301.5, end: 306.9, confidence: 0.7 },
    ],
    815,
  );
  assert.deepEqual(out.map((s) => s.category), ['sponsor', 'interaction']);
  const sc = scoreVideo([{ category: 'sponsor', start: 226, end: 314 }], out);
  assert.equal(sc.falsePositives.length, 0);
});

test('refine fits sponsor detections to a chapter the creator titled Sponsor', () => {
  // 4kYyd_hoqUw: the model split the read and pulled in a content line before it.
  const chapters = [{ title: 'Things In The Woods', start: 240 }, { title: 'Sponsor', start: 420 }, { title: 'Phenomena', start: 520 }];
  const out = refine(
    [
      { category: 'sponsor', start: 411.8, end: 423.4, confidence: 0.6 },
      { category: 'sponsor', start: 423.4, end: 515.6, confidence: 0.95 },
    ],
    1470,
    chapters,
  );
  assert.deepEqual(out.map((s) => [s.category, s.start, s.end]), [['sponsor', 420, 520]]);
});

test('refine merges same-category neighbors but keeps different categories apart', () => {
  const out = refine(
    [
      { category: 'interaction', start: 3227, end: 3234, confidence: 1 },
      { category: 'selfpromo', start: 3234, end: 3240, confidence: 1 },
      { category: 'selfpromo', start: 3240.5, end: 3253.5, confidence: 1 },
    ],
    3256,
  );
  assert.deepEqual(out.map((s) => [s.category, s.start, s.end]), [['interaction', 3227, 3234], ['selfpromo', 3234, 3256]]);
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
        content: [{ type: 'tool_use', id: 't1', name: TOOL.name, input: { segments: [{ category: 'sponsor', first_line: 0, first_words: "Today's video", last_line: 1, last_words: 'back to it.', confidence: 0.9 }] } }],
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
  assert.deepEqual(r.segments.map((s) => s.category), ['sponsor']);
  assert.equal(r.segments[0]?.end, 314.1);
});

test('the provider falls back to an unforced tool call when a model refuses a forced one', async () => {
  const choices: unknown[] = [];
  const provider = createAnthropicProvider(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    choices.push(body.tool_choice);
    if (body.tool_choice.type === 'tool') {
      return new Response(JSON.stringify({ error: { message: 'tool_choice: type "tool" and "any" are not supported for this model.' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ content: [{ type: 'thinking' }, { type: 'tool_use', name: TOOL.name, input: { segments: [] } }], usage: {} }), { status: 200 });
  });
  const opts = { apiKey: 'k', model: 'claude-sonnet-5-5' };
  assert.deepEqual((await provider.detect(input, opts)).segments, []);
  await provider.detect(input, opts);
  // The refusal is remembered: the second video goes straight to the unforced call.
  assert.deepEqual(choices.map((c) => (c as { type: string }).type), ['tool', 'auto', 'auto']);
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

test('scoreVideo accepts any boundary inside a ground-truth range', () => {
  // 5k_YlkT1bjc: Jeff has no preference between ending at "see you on the next episode" and the video end.
  const truth = [{ category: 'interaction' as const, start: 1843, end: 1856, endRange: [1849, 1856] as [number, number] }];
  const early = scoreVideo(truth, [{ category: 'interaction', start: 1843.6, end: 1849.8 }]).matches[0]!;
  assert.deepEqual([early.end.pitchShown, early.end.contentLost, early.end.pass], [0, 0, true]);
  const tooEarly = scoreVideo(truth, [{ category: 'interaction', start: 1843.6, end: 1848 }]).matches[0]!;
  assert.equal(tooEarly.end.pitchShown, 1);
});
