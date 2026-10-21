import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUrl, createSponsorBlockSource, parseResponse, sha256Hex } from '../src/sources/sponsorblock';

test('sha256Hex matches a known digest', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('buildUrl asks for all three categories and skip actions only', () => {
  const url = new URL(buildUrl('ab12'));
  assert.equal(url.origin + url.pathname, 'https://sponsor.ajay.app/api/skipSegments/ab12');
  assert.deepEqual(JSON.parse(url.searchParams.get('categories') ?? ''), ['sponsor', 'selfpromo', 'interaction']);
  assert.deepEqual(JSON.parse(url.searchParams.get('actionTypes') ?? ''), ['skip']);
  assert.equal(url.searchParams.get('service'), 'YouTube');
});

const BODY = [
  { videoID: 'otherVideo1', segments: [{ segment: [1, 2], category: 'sponsor', actionType: 'skip', UUID: 'x' }] },
  {
    videoID: 'wIe3eDfGKUo',
    segments: [
      { segment: [226.1, 314.2], category: 'sponsor', actionType: 'skip', UUID: 'u1', votes: 3, locked: 0, videoDuration: 815 },
      { segment: [10, 20], category: 'sponsor', actionType: 'mute', UUID: 'u2' },
      { segment: [30, 40], category: 'music_offtopic', actionType: 'skip', UUID: 'u3' },
      { segment: [50, 45], category: 'selfpromo', actionType: 'skip', UUID: 'u4' },
      { segment: ['1', 2], category: 'selfpromo', actionType: 'skip', UUID: 'u5' },
      { segment: [800, 815], category: 'interaction', actionType: 'skip', UUID: 'u6' },
      null,
    ],
  },
];

test('parseResponse keeps only this video, skip actions, known categories, and valid spans', () => {
  assert.deepEqual(parseResponse(BODY, 'wIe3eDfGKUo'), [
    { id: 'sponsorblock:u1', category: 'sponsor', start: 226.1, end: 314.2, source: 'sponsorblock' },
    { id: 'sponsorblock:u6', category: 'interaction', start: 800, end: 815, source: 'sponsorblock' },
  ]);
  assert.deepEqual(parseResponse(BODY, 'notInBody00'), []);
  assert.deepEqual(parseResponse({ not: 'an array' }, 'wIe3eDfGKUo'), []);
});

function fakeFetch(status: number, body: unknown) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fn, calls };
}

test('queries by a 4-character hash prefix, never the video ID', async () => {
  const { fn, calls } = fakeFetch(200, BODY);
  const source = createSponsorBlockSource(fn);
  const segments = await source.getSegments({ platform: 'youtube', id: 'wIe3eDfGKUo' });
  assert.equal(segments.length, 2);
  const prefix = (await sha256Hex('wIe3eDfGKUo')).slice(0, 4);
  assert.ok(calls[0]?.includes(`/api/skipSegments/${prefix}?`));
  assert.ok(!calls[0]?.includes('wIe3eDfGKUo'));
});

test('404 means no segments; other errors throw', async () => {
  assert.deepEqual(await createSponsorBlockSource(fakeFetch(404, 'Not Found').fn).getSegments({ platform: 'youtube', id: 'aaaaaaaaaaa' }), []);
  await assert.rejects(createSponsorBlockSource(fakeFetch(500, {}).fn).getSegments({ platform: 'youtube', id: 'aaaaaaaaaaa' }), /HTTP 500/);
});

test('supports YouTube only', () => {
  const source = createSponsorBlockSource(fakeFetch(200, []).fn);
  assert.equal(source.supports('youtube'), true);
  assert.equal(source.supports('vimeo'), false);
});
