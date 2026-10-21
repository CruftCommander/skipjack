import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SegmentService } from '../src/background/segments';
import { isRequest } from '../src/core/messages';
import type { SegmentSource } from '../src/sources/source';
import { seg } from './helpers';

function source(id: string, impl: () => Promise<ReturnType<typeof seg>[]>, platform = 'youtube') {
  let calls = 0;
  const s: SegmentSource = {
    id,
    supports: (p) => p === platform,
    getSegments: () => {
      calls++;
      return impl();
    },
  };
  return { s, calls: () => calls };
}

const media = { platform: 'youtube', id: 'abcdefghijk' };

test('merges sources and caches the answer', async () => {
  let now = 0;
  const a = source('a', async () => [seg('sponsor', 1, 2)]);
  const b = source('b', async () => [seg('selfpromo', 3, 9)]);
  const service = new SegmentService([a.s, b.s], () => now);
  const first = await service.get(media);
  assert.deepEqual(first.ok && [first.segments.length, first.sources], [2, ['a', 'b']]);
  await service.get(media);
  assert.equal(a.calls(), 1);
  now += 16 * 60 * 1000; // past the cache lifetime
  await service.get(media);
  assert.equal(a.calls(), 2);
});

test('one failing source does not hide the others', async () => {
  const ok = source('ok', async () => [seg('sponsor', 1, 2)]);
  const bad = source('bad', async () => {
    throw new Error('down');
  });
  const r = await new SegmentService([ok.s, bad.s]).get(media);
  assert.deepEqual(r.ok && r.sources, ['ok']);
});

test('when every source fails, reports the error and does not cache it', async () => {
  const bad = source('bad', async () => {
    throw new Error('down');
  });
  const service = new SegmentService([bad.s]);
  const r = await service.get(media);
  assert.deepEqual(r, { ok: false, error: 'bad: down' });
  await service.get(media);
  assert.equal(bad.calls(), 2);
});

test('sources for other platforms are not asked', async () => {
  const other = source('other', async () => [seg('sponsor', 1, 2)], 'vimeo');
  const r = await new SegmentService([other.s]).get(media);
  assert.deepEqual(r, { ok: true, segments: [], sources: [] });
  assert.equal(other.calls(), 0);
});

test('isRequest accepts only well-formed getSegments messages', () => {
  assert.equal(isRequest({ type: 'getSegments', media }), true);
  for (const bad of [null, 'x', {}, { type: 'getSegments' }, { type: 'getSegments', media: { platform: '', id: 'x' } }, { type: 'other', media }]) {
    assert.equal(isRequest(bad), false);
  }
});
