import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheKey, DetectionService, HOURLY_LIMIT } from '../src/background/detection';
import { DETECTION_STATUS_KEY, detectionCacheKeys, isDetectRequest, MAX_CHAPTERS, MAX_PROMO_LINES, MAX_TRANSCRIPT_CHARS } from '../src/core/messages';
import { normalizeSettings } from '../src/core/settings';
import { DETECTION_SOURCE, mergeSources, missingCategories, shouldDetect } from '../src/core/sources';
import { SpentError, type DetectionInput, type LlmProvider } from '../src/llm/provider';
import { parseJson3 } from '../src/platforms/youtube';
import { fakeShell, seg } from './helpers';

const input: DetectionInput = {
  media: { platform: 'youtube', id: 'abcdefghijk' },
  durationSeconds: 600,
  transcript: [{ start: 1, duration: 2, text: 'hello' }],
  signals: {},
};

test('detection settings default to filling gaps with Sonnet and the captions toggle on', () => {
  assert.deepEqual(normalizeSettings(undefined).detection, { mode: 'fillGaps', model: 'claude-sonnet-5-5', captionsToggle: true });
  assert.deepEqual(normalizeSettings({ detection: { mode: 'bogus', model: 'Bad Model!', captionsToggle: 'x' } }).detection, {
    mode: 'fillGaps',
    model: 'claude-sonnet-5-5',
    captionsToggle: true,
  });
  assert.equal(normalizeSettings({ detection: { mode: 'off', model: 'claude-haiku-5-5' } }).detection.model, 'claude-haiku-5-5');
});

test('shouldDetect follows the mode, the enabled categories, and the duration', () => {
  const s = normalizeSettings(undefined);
  const sponsorOnly = [seg('sponsor', 10, 40)];
  assert.equal(shouldDetect('fillGaps', sponsorOnly, s, 600), true);
  assert.equal(shouldDetect('noCommunity', sponsorOnly, s, 600), false);
  assert.equal(shouldDetect('noCommunity', [], s, 600), true);
  assert.equal(shouldDetect('off', [], s, 600), false);
  assert.equal(shouldDetect('fillGaps', [], s, 45), false);
  assert.equal(shouldDetect('fillGaps', [], s, Number.POSITIVE_INFINITY), false);
  assert.equal(shouldDetect('fillGaps', [], normalizeSettings({ enabled: false }), 600), false);
  const all = [seg('sponsor', 1, 9), seg('selfpromo', 20, 30), seg('interaction', 40, 50)];
  assert.equal(shouldDetect('fillGaps', all, s, 600), false);
  // With reminders and self-promotion switched off, a sponsor-only result covers everything wanted.
  const sponsorsOnly = normalizeSettings({ categories: { selfpromo: false, interaction: false } });
  assert.deepEqual(missingCategories(sponsorOnly, sponsorsOnly), []);
});

test('mergeSources lets the community win for any category it has', () => {
  const community = [seg('sponsor', 100, 160, 'sb')];
  const detected = [
    { ...seg('sponsor', 98, 162, 'd1'), source: DETECTION_SOURCE },
    { ...seg('interaction', 10, 30, 'd2'), source: DETECTION_SOURCE },
  ];
  assert.deepEqual(mergeSources(community, detected).map((s) => s.id), ['sb', 'd2']);
});

test('parseJson3 reads caption events and skips empty ones', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 5000 },
      { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'brought ' }, { utf8: 'to you', tOffsetMs: 400 }] },
      { tStartMs: 3600, dDurationMs: 100, segs: [{ utf8: '\n' }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: 'by Sentry' }] },
    ],
  });
  assert.deepEqual(parseJson3(body), [
    [1.5, 2, 'brought to you'],
    [4, 1, 'by Sentry'],
  ]);
  assert.deepEqual(parseJson3('<html>'), []);
});

test('isDetectRequest validates the transcript it is handed', () => {
  assert.equal(isDetectRequest({ type: 'detect', model: 'm', input }), true);
  assert.equal(isDetectRequest({ type: 'detect', model: 'm', input: { ...input, transcript: [] } }), false);
  assert.equal(isDetectRequest({ type: 'detect', model: 'm', input: { ...input, transcript: [{ start: 'x' }] } }), false);
  assert.equal(isDetectRequest({ type: 'detect', input }), false);
});

test('isDetectRequest refuses requests past its size and sanity limits', () => {
  const ok = (i: unknown) => isDetectRequest({ type: 'detect', model: 'm', input: i });
  const cue = (start: number, text = 'x') => ({ start, duration: 1, text });
  assert.equal(ok({ ...input, signals: undefined }), false);
  assert.equal(ok({ ...input, durationSeconds: Number.NaN }), false);
  assert.equal(ok({ ...input, durationSeconds: Number.POSITIVE_INFINITY }), false);
  assert.equal(ok({ ...input, transcript: [{ start: Number.NaN, duration: 1, text: 'x' }] }), false);
  assert.equal(ok({ ...input, transcript: [cue(5000)] }), false);
  assert.equal(ok({ ...input, transcript: [cue(1, 'y'.repeat(2001))] }), false);
  // Total characters: 250 cues of 1,999 characters is under the cue limit but over the total.
  const big = Array.from({ length: Math.ceil(MAX_TRANSCRIPT_CHARS / 1999) + 1 }, (_, i) => cue(i % 600, 'z'.repeat(1999)));
  assert.equal(ok({ ...input, transcript: big }), false);
  const chapters = Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => ({ title: 'c', start: i }));
  assert.equal(ok({ ...input, signals: { chapters } }), false);
  assert.equal(ok({ ...input, signals: { chapters: chapters.slice(0, MAX_CHAPTERS) } }), true);
  assert.equal(ok({ ...input, signals: { chapters: [{ title: 'c', start: 601 }] } }), false);
  assert.equal(ok({ ...input, signals: { descriptionPromoLines: Array(MAX_PROMO_LINES + 1).fill('code') } }), false);
  assert.equal(ok({ ...input, signals: { paidPromotion: 'yes' } }), false);
  assert.equal(ok({ ...input, signals: { paidPromotion: true, descriptionPromoLines: ['use code X'] } }), true);
});

function fakeProvider(calls: { n: number }, fail: boolean | 'spent' = false): LlmProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet' }],
    async detect() {
      calls.n++;
      await new Promise((r) => setTimeout(r, 10));
      if (fail === 'spent') throw new SpentError('Anthropic: no report_segments call in the response');
      if (fail) throw new Error('Anthropic: invalid x-api-key');
      return {
        model: 'claude-sonnet-5-5',
        usage: { inputTokens: 1234, outputTokens: 56 },
        segments: [{ category: 'interaction', start: 12.345, end: 37.9, confidence: 0.9 }],
      };
    },
  };
}

test('DetectionService calls the provider once, caches the result, and shares a request in flight', async () => {
  const shell = fakeShell();
  const calls = { n: 0 };
  const service = new DetectionService(shell, () => fakeProvider(calls), async () => 'sk-ant-key');
  const [a, b] = await Promise.all([service.detect(input, 'claude-sonnet-5-5'), service.detect(input, 'claude-sonnet-5-5')]);
  assert.equal(calls.n, 1);
  assert.deepEqual(a, b);
  assert.ok(a.ok && !a.cached && a.segments[0]?.source === DETECTION_SOURCE);
  assert.ok(shell.local[cacheKey(input.media)]);
  const again = await service.detect(input, 'claude-sonnet-5-5');
  assert.ok(again.ok && again.cached);
  assert.equal(calls.n, 1);
  const status = await service.status(input.media, 'claude-sonnet-5-5');
  assert.ok(status.ok && status.keySet && status.cached?.length === 1);
  assert.equal((shell.local[DETECTION_STATUS_KEY] as { ok: boolean }).ok, true);
});

test('DetectionService reports a missing key or a provider error without caching', async () => {
  const shell = fakeShell();
  const calls = { n: 0 };
  const noKey = new DetectionService(shell, () => fakeProvider(calls), async () => null);
  const r1 = await noKey.detect(input, 'claude-sonnet-5-5');
  assert.deepEqual(r1, { ok: false, error: 'No Anthropic API key is set.' });
  assert.equal(calls.n, 0);
  const failing = new DetectionService(shell, () => fakeProvider(calls, true), async () => 'k');
  const r2 = await failing.detect(input, 'claude-sonnet-5-5');
  assert.deepEqual(r2, { ok: false, error: 'Anthropic: invalid x-api-key' });
  assert.equal(shell.local[cacheKey(input.media)], undefined);
  assert.equal((shell.local[DETECTION_STATUS_KEY] as { message: string }).message, 'Anthropic: invalid x-api-key');
  const unknown = new DetectionService(shell, () => null, async () => 'k');
  assert.deepEqual(await unknown.detect(input, 'gpt-x'), { ok: false, error: 'No provider offers the model gpt-x.' });
});

test('DetectionService treats an old cache entry as missing', async () => {
  const shell = fakeShell();
  const calls = { n: 0 };
  let now = 1_000_000_000_000;
  const service = new DetectionService(shell, () => fakeProvider(calls), async () => 'k', () => now);
  await service.detect(input, 'claude-sonnet-5-5');
  now += 61 * 24 * 60 * 60 * 1000;
  const r = await service.detect(input, 'claude-sonnet-5-5');
  assert.ok(r.ok && !r.cached);
  assert.equal(calls.n, 2);
});

test('DetectionService remembers a failure that cost tokens for a day', async () => {
  const shell = fakeShell();
  const calls = { n: 0 };
  let now = 1_000_000_000_000;
  let fail: boolean | 'spent' = 'spent';
  const service = new DetectionService(shell, () => fakeProvider(calls, fail), async () => 'k', () => now);
  const r1 = await service.detect(input, 'claude-sonnet-5-5');
  assert.equal(r1.ok, false);
  const r2 = await service.detect(input, 'claude-sonnet-5-5');
  assert.ok(!r2.ok && /within the last day/.test(r2.error));
  assert.equal(calls.n, 1);
  const status = await service.status(input.media, 'claude-sonnet-5-5');
  assert.ok(!status.ok && /within the last day/.test(status.error));
  now += 25 * 60 * 60 * 1000;
  fail = false;
  const r3 = await service.detect(input, 'claude-sonnet-5-5');
  assert.ok(r3.ok && !r3.cached);
  assert.equal(calls.n, 2);
});

test('DetectionService stops at the hourly limit and resumes as the hour rolls on', async () => {
  const shell = fakeShell();
  const calls = { n: 0 };
  let now = 1_000_000_000_000;
  const service = new DetectionService(shell, () => fakeProvider(calls), async () => 'k', () => now);
  const media = (i: number) => ({ platform: 'youtube', id: `video${String(i).padStart(6, '0')}` });
  // Concurrent requests must not overshoot the limit.
  const results = await Promise.all(
    Array.from({ length: HOURLY_LIMIT + 3 }, (_, i) => service.detect({ ...input, media: media(i) }, 'claude-sonnet-5-5')),
  );
  assert.equal(results.filter((r) => r.ok).length, HOURLY_LIMIT);
  assert.equal(calls.n, HOURLY_LIMIT);
  const status = await service.status(media(999), 'claude-sonnet-5-5');
  assert.ok(!status.ok && /an hour/.test(status.error));
  // A cached video is still answered at the limit.
  const cachedStatus = await service.status(media(0), 'claude-sonnet-5-5');
  assert.ok(cachedStatus.ok && cachedStatus.cached?.length === 1);
  now += 60 * 60 * 1000 + 1;
  assert.ok((await service.detect({ ...input, media: media(999) }, 'claude-sonnet-5-5')).ok);
});

test('DetectionService status names a model no provider offers', async () => {
  const service = new DetectionService(fakeShell(), () => null, async () => 'k');
  const status = await service.status(input.media, 'claude-future-9');
  assert.ok(!status.ok && /claude-future-9/.test(status.error));
});

test('DetectionService prunes the oldest results past its limit', async () => {
  const shell = fakeShell();
  let now = 1_000_000_000_000;
  for (let i = 0; i < 2000; i++) {
    shell.local[`det:youtube:old${String(i).padStart(8, '0')}`] = { at: now - 1_000_000 + i, model: 'm', segments: [] };
  }
  const service = new DetectionService(shell, () => fakeProvider({ n: 0 }), async () => 'k', () => now);
  await service.detect(input, 'claude-sonnet-5-5');
  const keys = Object.keys(shell.local).filter((k) => k.startsWith('det:'));
  assert.equal(keys.length, 2000);
  assert.ok(!keys.includes('det:youtube:old00000000'));
  assert.ok(keys.includes(cacheKey(input.media)));
});

// Follow-up to the 2026-10-21 self-review of 201e6de.

const model = 'claude-sonnet-5-5';

/** A provider whose detect() is scripted per test. */
function scripted(run: LlmProvider['detect']): LlmProvider {
  return { id: 'anthropic', label: 'Anthropic', models: [{ id: model, label: 'Sonnet' }], detect: run };
}

/** Waits for the signal, then throws what fetch() or the provider would. */
const untilAborted = (signal: AbortSignal | undefined, error: () => Error): Promise<never> =>
  new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(error())));
const abortError = () => new DOMException('The operation was aborted.', 'AbortError') as Error;

const ok = { model, usage: { inputTokens: 10, outputTokens: 2 }, segments: [{ category: 'sponsor' as const, start: 5, end: 25, confidence: 0.9 }] };

test('a timeout before the provider accepted the request is not held; the next visit tries again', async () => {
  const shell = fakeShell();
  let calls = 0;
  const provider = scripted(async (_i, o) => {
    calls++;
    return untilAborted(o.signal, abortError);
  });
  const service = new DetectionService(shell, () => provider, async () => 'k', undefined, { idleTimeoutMs: 20 });
  const r = await service.detect(input, model);
  assert.ok(!r.ok && /timed out before Anthropic accepted/.test(r.error));
  assert.equal(shell.local[cacheKey(input.media)], undefined);
  await service.detect(input, model);
  assert.equal(calls, 2);
});

test('a timeout after the provider accepted the request holds the video for a day', async () => {
  const shell = fakeShell();
  let calls = 0;
  const provider = scripted(async (_i, o) => {
    calls++;
    o.onActivity?.();
    return untilAborted(o.signal, () => new SpentError('Anthropic: timed out while the response was streaming'));
  });
  const service = new DetectionService(shell, () => provider, async () => 'k', undefined, { idleTimeoutMs: 20 });
  const r = await service.detect(input, model);
  assert.ok(!r.ok && /timed out after Anthropic accepted/.test(r.error));
  const again = await service.detect(input, model);
  assert.ok(!again.ok && /within the last day/.test(again.error));
  assert.equal(calls, 1);
});

test('the timeout is an idle timeout: activity keeps a slow detection going, up to the total limit', async () => {
  const steady = scripted(async (_i, o) => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 10));
      o.onActivity?.();
    }
    return ok;
  });
  // 80 ms in all, but never 30 ms without activity.
  const r = await new DetectionService(fakeShell(), () => steady, async () => 'k', undefined, { idleTimeoutMs: 30 }).detect(input, model);
  assert.ok(r.ok, JSON.stringify(r));

  const endless = scripted(async (_i, o) => {
    const t = setInterval(() => o.onActivity?.(), 5);
    try {
      return await untilAborted(o.signal, () => new SpentError('Anthropic: timed out while the response was streaming'));
    } finally {
      clearInterval(t);
    }
  });
  const capped = await new DetectionService(fakeShell(), () => endless, async () => 'k', undefined, { idleTimeoutMs: 30, totalTimeoutMs: 60 }).detect(input, model);
  assert.ok(!capped.ok && /timed out/.test(capped.error));
});

test('the background is kept alive while any detection runs, and only then', async () => {
  const shell = fakeShell();
  const timers: { fn: () => void; stopped: boolean }[] = [];
  const every = (fn: () => void) => {
    const t = { fn, stopped: false };
    timers.push(t);
    return () => void (t.stopped = true);
  };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const provider = scripted(async () => {
    await gate;
    return ok;
  });
  const service = new DetectionService(shell, () => provider, async () => 'k', undefined, { every });
  const a = service.detect(input, model);
  const b = service.detect({ ...input, media: { platform: 'youtube', id: 'zzzzzzzzzzz' } }, model);
  await new Promise((r) => setTimeout(r, 5));
  // One timer for both detections.
  assert.equal(timers.length, 1);
  timers[0]!.fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(shell.keepAlives, 1);
  assert.equal(timers[0]!.stopped, false);
  release();
  await Promise.all([a, b]);
  assert.equal(timers[0]!.stopped, true);
  // A cached answer is quick; it still starts and stops a timer cleanly.
  await service.detect(input, model);
  assert.ok(timers.every((t) => t.stopped));
});

test('status records the hourly limit and an unknown model for the settings page, once per message', async () => {
  const shell = fakeShell();
  let now = 1_000_000_000_000;
  shell.local.detectionBudget = Array.from({ length: HOURLY_LIMIT }, () => now - 1000);
  shell.local[DETECTION_STATUS_KEY] = { at: now - 5000, ok: true, message: '1 segment(s) found with claude-sonnet-5-5' };
  const service = new DetectionService(shell, () => fakeProvider({ n: 0 }), async () => 'k', () => now);
  const s = await service.status(input.media, model);
  assert.ok(!s.ok);
  const recorded = shell.local[DETECTION_STATUS_KEY] as { at: number; ok: boolean; message: string };
  assert.equal(recorded.ok, false);
  assert.match(recorded.message, /limit of 60 detections an hour/);
  now += 1000;
  await service.status({ platform: 'youtube', id: 'other000000' }, model);
  assert.equal((shell.local[DETECTION_STATUS_KEY] as { at: number }).at, recorded.at, 'the same refusal is not rewritten');

  const unknown = new DetectionService(shell, () => null, async () => 'k', () => now);
  await unknown.status(input.media, 'claude-future-9');
  assert.match((shell.local[DETECTION_STATUS_KEY] as { message: string }).message, /claude-future-9/);
});

test('a failure hold applies only to the model that failed', async () => {
  const shell = fakeShell();
  const calls = { n: 0 };
  let fail: boolean | 'spent' = 'spent';
  const service = new DetectionService(shell, () => fakeProvider(calls, fail), async () => 'k');
  await service.detect(input, 'claude-sonnet-5-5');
  const held = await service.status(input.media, 'claude-sonnet-5-5');
  assert.ok(!held.ok && /within the last day/.test(held.error));
  const other = await service.status(input.media, 'claude-haiku-5-5');
  assert.ok(other.ok && other.cached === null);
  fail = false;
  const r = await service.detect(input, 'claude-haiku-5-5');
  assert.ok(r.ok && !r.cached);
  assert.equal(calls.n, 2);
});

test('a paid result is used even when saving it fails', async () => {
  const shell = fakeShell();
  const set = shell.setLocalItems;
  shell.setLocalItems = async (items) => {
    if (Object.keys(items).some((k) => k.startsWith('det:'))) throw new Error('QUOTA_BYTES quota exceeded');
    return set(items);
  };
  shell.getAllLocal = async () => {
    throw new Error('storage unavailable');
  };
  const service = new DetectionService(shell, () => fakeProvider({ n: 0 }), async () => 'k');
  const r = await service.detect(input, model);
  assert.ok(r.ok && r.segments.length === 1, JSON.stringify(r));
  assert.equal((shell.local[DETECTION_STATUS_KEY] as { ok: boolean }).ok, true);
});

test('Clear detection cache removes results, failure holds, and the last status, and nothing else', () => {
  const keys = detectionCacheKeys({
    'det:youtube:aaaaaaaaaaa': {},
    'det:youtube:bbbbbbbbbbb': { failed: 'x' },
    [DETECTION_STATUS_KEY]: {},
    'apiKey:anthropic': 'sk-ant-x',
    detectionBudget: [],
    settings: {},
  });
  assert.deepEqual(keys.sort(), ['det:youtube:aaaaaaaaaaa', 'det:youtube:bbbbbbbbbbb', DETECTION_STATUS_KEY].sort());
});
