import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRuns, decide, nextStart, PAUSE_BEFORE_END_SECONDS, planSkips } from '../src/core/policy';
import { normalizeSettings } from '../src/core/settings';
import { seg, settings } from './helpers';

const none = new Set<string>();

test('disabled categories and the master switch remove segments', () => {
  const segments = [seg('sponsor', 10, 40), seg('interaction', 50, 60), seg('selfpromo', 70, 90)];
  assert.equal(planSkips(segments, settings()).length, 3);
  assert.deepEqual(
    planSkips(segments, settings({ categories: { interaction: false } })).map((p) => p.segment.category),
    ['sponsor', 'selfpromo'],
  );
  assert.equal(planSkips(segments, settings({ enabled: false })).length, 0);
});

test('minimum length applies to reminders and self-promotion, never to sponsors', () => {
  const segments = [seg('sponsor', 10, 12), seg('interaction', 50, 53), seg('selfpromo', 70, 74.9), seg('selfpromo', 80, 85)];
  const plan = planSkips(segments, settings());
  assert.deepEqual(
    plan.map((p) => [p.segment.category, p.segment.start]),
    [['sponsor', 10], ['selfpromo', 80]],
  );
  assert.equal(planSkips(segments, settings({ minLength: { enabled: false } })).length, 4);
});

test('margins widen the window, clamped at zero', () => {
  const plan = planSkips([seg('sponsor', 0.2, 30)], settings({ margin: { beforeSeconds: 0.5, afterSeconds: 1 } }));
  assert.equal(plan[0]?.from, 0);
  assert.equal(plan[0]?.to, 31);
});

test('malformed segments are dropped and the plan is sorted', () => {
  const plan = planSkips([seg('sponsor', 90, 100), seg('sponsor', 50, 40), seg('sponsor', Number.NaN, 5), seg('sponsor', 10, 20)], settings());
  assert.deepEqual(plan.map((p) => p.from), [10, 90]);
});

test('skips to the end of the window when inside it', () => {
  const plan = planSkips([seg('sponsor', 10, 40)], settings());
  assert.deepEqual(decide(9.9, 600, plan, none, settings()), { kind: 'none' });
  const d = decide(10, 600, plan, none, settings());
  assert.equal(d.kind, 'skip');
  assert.equal(d.kind === 'skip' && d.seekTo, 40);
  assert.equal(d.kind === 'skip' && d.pause, false);
  assert.deepEqual(decide(40, 600, plan, none, settings()), { kind: 'none' });
});

test('suppressed segments are not skipped', () => {
  const plan = planSkips([seg('sponsor', 10, 40, 'a')], settings());
  assert.deepEqual(decide(20, 600, plan, new Set(['a']), settings()), { kind: 'none' });
});

test('a skip shorter than the minimum seek is not worth doing', () => {
  const plan = planSkips([seg('sponsor', 10, 40)], settings());
  assert.deepEqual(decide(39.95, 600, plan, none, settings()), { kind: 'none' });
});

test('overlapping windows merge into one run, skipped with one seek', () => {
  const plan = planSkips([seg('sponsor', 10, 40), seg('selfpromo', 35, 60)], settings());
  const d = decide(12, 600, plan, none, settings());
  assert.equal(d.kind === 'skip' && d.seekTo, 60);
  assert.equal(d.kind === 'skip' && d.run.windows.length, 2);
});

test('with the default margins, back-to-back segments form one run', () => {
  const real = normalizeSettings(undefined);
  const plan = planSkips([seg('sponsor', 100, 160, 'a'), seg('selfpromo', 160, 190, 'b')], real);
  const runs = buildRuns(plan, none);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0]?.from, runs[0]?.to], [99.5, 190.5]);
  const d = decide(100, 600, plan, none, real);
  assert.equal(d.kind === 'skip' && d.seekTo, 190.5);
  // Undoing removes both segments, so nothing in the run is skipped from its start.
  assert.deepEqual(decide(99.5, 600, plan, new Set(['a', 'b']), real), { kind: 'none' });
});

test('an undone segment splits a run', () => {
  const plan = planSkips([seg('sponsor', 10, 40, 'a'), seg('selfpromo', 35, 60, 'b')], settings());
  const d = decide(45, 600, plan, new Set(['a']), settings());
  assert.equal(d.kind === 'skip' && d.seekTo, 60);
  assert.deepEqual(decide(20, 600, plan, new Set(['a']), settings()), { kind: 'none' });
});

test('unknown duration (live) skips normally and ignores the end rule', () => {
  const plan = planSkips([seg('interaction', 10, 40)], settings());
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = decide(20, duration, plan, none, settings());
    assert.equal(d.kind === 'skip' && d.seekTo, 40);
  }
});

// The Brew outro from 2026-10-21: a reminder at 53:47-53:54, then self-promotion to the end (54:16).
test('end rule, default "play": the reminder is skipped, the self-promotion that runs to the end plays', () => {
  const duration = 3256;
  const real = normalizeSettings(undefined); // real margins, so the two segments form one run
  const plan = planSkips([seg('interaction', 3227, 3234), seg('selfpromo', 3234, 3256)], real);
  assert.equal(buildRuns(plan, none).length, 1);
  const d = decide(3227, duration, plan, none, real);
  assert.equal(d.kind === 'skip' && d.seekTo, 3234.5);
  assert.deepEqual(decide(3234.5, duration, plan, none, real), { kind: 'none' });
});

test('end rule uses the threshold', () => {
  const plan = planSkips([seg('interaction', 500, 594)], settings());
  // Lands 6 s before the end: outside a 5 s threshold, so it skips.
  assert.equal(decide(510, 600, plan, none, settings()).kind, 'skip');
  // A 10 s threshold catches it.
  assert.equal(decide(510, 600, plan, none, settings({ endOfVideo: { thresholdSeconds: 10 } })).kind, 'none');
});

test('end rule "skip" lands on the end; "skipAndPause" lands just before it and pauses', () => {
  const plan = planSkips([seg('interaction', 580, 600)], settings());
  const skip = decide(585, 600, plan, none, settings({ endOfVideo: { action: 'skip' } }));
  assert.deepEqual(skip.kind === 'skip' && [skip.seekTo, skip.pause], [600, false]);
  const pause = decide(585, 600, plan, none, settings({ endOfVideo: { action: 'skipAndPause' } }));
  assert.deepEqual(pause.kind === 'skip' && [pause.seekTo, pause.pause], [600 - PAUSE_BEFORE_END_SECONDS, true]);
});

test('end rule "skipAndPause" pauses at the end of the run when that is earlier than the end', () => {
  const plan = planSkips([seg('sponsor', 3230, 3251)], settings({ endOfVideo: { action: 'skipAndPause' } }));
  const d = decide(3231, 3256, plan, none, settings({ endOfVideo: { action: 'skipAndPause' } }));
  assert.deepEqual(d.kind === 'skip' && [d.seekTo, d.pause], [3251, true]);
});

test('end rule "play" never lets a sponsor play: it skips and pauses instead', () => {
  const plan = planSkips([seg('sponsor', 580, 600)], settings());
  const d = decide(585, 600, plan, none, settings());
  assert.deepEqual(d.kind === 'skip' && [d.seekTo, d.pause], [600 - PAUSE_BEFORE_END_SECONDS, true]);
});

test('already past the pause point: pause in place, never seek backward', () => {
  const plan = planSkips([seg('sponsor', 580, 600)], settings());
  const d = decide(599.9, 600, plan, none, settings());
  assert.deepEqual(d.kind === 'skip' && [d.seekTo, d.pause], [599.9, true]);
});

test('a window that ends past the media end is clamped to the end', () => {
  const plan = planSkips([seg('sponsor', 100, 700)], settings({ endOfVideo: { action: 'skip' } }));
  const d = decide(150, 600, plan, none, settings({ endOfVideo: { action: 'skip' } }));
  assert.equal(d.kind === 'skip' && d.seekTo, 600);
});

test('nextStart finds the next unsuppressed window', () => {
  const plan = planSkips([seg('sponsor', 10, 20, 'a'), seg('sponsor', 30, 40, 'b')], settings());
  assert.equal(nextStart(0, plan, none), 10);
  assert.equal(nextStart(0, plan, new Set(['a'])), 30);
  assert.equal(nextStart(15, plan, none), 30);
  assert.equal(nextStart(35, plan, none), null);
});
