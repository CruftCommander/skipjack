import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelStore } from '../src/browser/channel-store';
import type { ChannelRef } from '../src/core/channels';
import { normalizeSettings } from '../src/core/settings';
import { Session } from '../src/content/session';
import type { PlatformAdapter } from '../src/platforms/platform';
import type { Toast } from '../src/ui/toast';
import { FakeMedia, fakeShell } from './helpers';

const X = 'UCxxxxxxxxxxxxxxxxxxxxxx';
const Y = 'UCyyyyyyyyyyyyyyyyyyyyyy';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toast = { show: () => undefined, hide: () => undefined, destroy: () => undefined } as unknown as Toast;

function setup(channelOf: () => ChannelRef | null) {
  const shell = fakeShell();
  let lookups = 0;
  shell.sendMessage = (async () => {
    lookups++;
    return { ok: true, segments: [], sources: ['test'] };
  }) as typeof shell.sendMessage;
  const adapter = {
    id: 'youtube',
    channelOf,
    findMediaElement: () => null,
    canSkipNow: () => true,
  } as unknown as PlatformAdapter;
  const store = new ChannelStore(shell);
  const make = (excluded: ChannelRef[]) =>
    new Session({ platform: 'youtube', id: 'abcdefghijk' }, adapter, shell, store, normalizeSettings(undefined), excluded, toast);
  return { shell, store, make, lookups: () => lookups };
}

test('an excluded channel is held back; un-excluding resumes exactly one lookup', async () => {
  const t = setup(() => ({ platform: 'youtube', id: X }));
  const s = t.make([{ platform: 'youtube', id: X }]);
  await sleep(50);
  assert.equal(t.lookups(), 0);
  s.updateExclusions([]);
  s.updateExclusions([]);
  await sleep(50);
  assert.equal(t.lookups(), 1);
  s.destroy();
});

test('a channel that is not excluded is looked up once, without waiting', async () => {
  const t = setup(() => ({ platform: 'youtube', id: Y }));
  const s = t.make([{ platform: 'youtube', id: X }]);
  await sleep(50);
  assert.equal(t.lookups(), 1);
  s.destroy();
});

test('with a handle-only entry, the session waits for the handle, holds back, and backfills the ID', async () => {
  let calls = 0;
  // The ID arrives first; the handle a few polls later.
  const t = setup(() => (++calls < 3 ? { platform: 'youtube', id: X } : { platform: 'youtube', id: X, handle: '@foo', name: 'Foo' }));
  await t.store.add({ platform: 'youtube', handle: '@foo' });
  const s = t.make(await t.store.list());
  await sleep(900);
  assert.equal(t.lookups(), 0);
  assert.deepEqual(await t.store.list(), [{ platform: 'youtube', id: X, handle: '@foo', name: 'Foo' }]);
  s.destroy();
});

test('a hold-back based on stale channel data is re-checked and resumes', async () => {
  let current: ChannelRef = { platform: 'youtube', id: X };
  const t = setup(() => current);
  const s = t.make([{ platform: 'youtube', id: X }]);
  await sleep(50);
  assert.equal(t.lookups(), 0);
  current = { platform: 'youtube', id: Y }; // the page now reports the real channel
  await sleep(2300);
  assert.equal(t.lookups(), 1);
  s.destroy();
});

// Detection in a session: what the content script does with the background's answers.

function detectSetup(answer: (type: string) => Promise<unknown>) {
  const shell = fakeShell();
  const sent: string[] = [];
  shell.sendMessage = (async (m: { type: string }) => {
    sent.push(m.type);
    return answer(m.type);
  }) as typeof shell.sendMessage;
  let transcripts = 0;
  const media = new FakeMedia();
  const adapter = {
    id: 'youtube',
    channelOf: () => null,
    findMediaElement: () => media,
    canSkipNow: () => true,
    lengthOf: () => 600,
    cancelTranscript: () => undefined,
    readTranscript: async () => {
      transcripts++;
      return {
        ok: true,
        input: { media: { platform: 'youtube', id: 'abcdefghijk' }, durationSeconds: 600, transcript: [{ start: 1, duration: 1, text: 'x' }], signals: {} },
      };
    },
  } as unknown as PlatformAdapter;
  const session = new Session({ platform: 'youtube', id: 'abcdefghijk' }, adapter, shell, new ChannelStore(shell), normalizeSettings(undefined), [], toast);
  return { session, sent, transcripts: () => transcripts, segments: () => (session as unknown as { segments: unknown[] }).segments };
}

const community = { ok: true, segments: [], sources: ['test'] };
const detected = { ok: true, cached: false, inputTokens: 1, outputTokens: 1, segments: [{ id: 'd', category: 'sponsor', start: 10, end: 40, source: 'detection' }] };

test('a refused detection status touches no captions and sends no transcript', async () => {
  const t = detectSetup(async (type) =>
    type === 'getSegments' ? community : type === 'detectionStatus' ? { ok: false, error: 'The limit of 60 detections an hour is reached.' } : detected,
  );
  try {
    await sleep(600);
    assert.deepEqual(t.sent, ['getSegments', 'detectionStatus']);
    assert.equal(t.transcripts(), 0);
  } finally {
    t.session.destroy();
  }
});

test('a detection that returns after the user switched detection off is not applied', async () => {
  let finish: (v: unknown) => void = () => undefined;
  const late = new Promise((r) => (finish = r));
  const t = detectSetup(async (type) => (type === 'getSegments' ? community : type === 'detectionStatus' ? { ok: true, cached: null, keySet: true } : late));
  try {
    await sleep(600);
    assert.deepEqual(t.sent, ['getSegments', 'detectionStatus', 'detect']);
    t.session.updateSettings(normalizeSettings({ detection: { mode: 'off' } }));
    finish(detected);
    await sleep(50);
    assert.equal(t.segments().length, 0);
  } finally {
    t.session.destroy();
  }

  // Control: with detection still on, the same reply is applied.
  const on = detectSetup(async (type) => (type === 'getSegments' ? community : type === 'detectionStatus' ? { ok: true, cached: null, keySet: true } : detected));
  try {
    await sleep(600);
    assert.equal(on.segments().length, 1);
  } finally {
    on.session.destroy();
  }
});
