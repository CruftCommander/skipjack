import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/settings';

test('empty or invalid storage yields the defaults', () => {
  for (const raw of [undefined, null, 'x', 42, [], {}]) {
    assert.deepEqual(normalizeSettings(raw), DEFAULT_SETTINGS);
  }
});

test('defaults match the decisions', () => {
  const d = normalizeSettings(undefined);
  assert.deepEqual(d.categories, { sponsor: true, selfpromo: true, interaction: true });
  assert.deepEqual(d.minLength, { enabled: true, seconds: 5 });
  assert.equal(d.toast.enabled, true);
  assert.deepEqual(d.endOfVideo, { action: 'play', thresholdSeconds: 5 });
  assert.deepEqual(d.diagnostics, { log: false });
});

test('partial settings keep the other defaults', () => {
  const s = normalizeSettings({ categories: { interaction: false }, endOfVideo: { action: 'skipAndPause' } });
  assert.deepEqual(s.categories, { sponsor: true, selfpromo: true, interaction: false });
  assert.deepEqual(s.endOfVideo, { action: 'skipAndPause', thresholdSeconds: 5 });
});

test('invalid values fall back and numbers are clamped', () => {
  const s = normalizeSettings({
    enabled: 'yes',
    minLength: { seconds: 9999 },
    endOfVideo: { action: 'explode', thresholdSeconds: -3 },
    margin: { beforeSeconds: Number.NaN, afterSeconds: 99 },
  });
  assert.equal(s.enabled, true);
  assert.equal(s.minLength.seconds, 120);
  assert.equal(s.endOfVideo.action, 'play');
  assert.equal(s.endOfVideo.thresholdSeconds, 0);
  assert.equal(s.margin.beforeSeconds, DEFAULT_SETTINGS.margin.beforeSeconds);
  assert.equal(s.margin.afterSeconds, 5);
});

test('unknown keys are dropped', () => {
  const s = normalizeSettings({ extra: 1, categories: { music: true } }) as unknown as Record<string, unknown>;
  assert.equal('extra' in s, false);
  assert.equal('music' in (s.categories as object), false);
});
