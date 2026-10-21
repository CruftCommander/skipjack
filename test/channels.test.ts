import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelListFullError, ChannelStore } from '../src/browser/channel-store';
import {
  channelKey,
  channelsFromItems,
  entryMatches,
  isExcluded,
  MAX_EXCLUDED_CHANNELS,
  needsHandle,
  upgradedEntry,
  type ChannelRef,
} from '../src/core/channels';
import { channelUrl, parseChannel } from '../src/platforms/registry';
import { handleFromUrl } from '../src/platforms/youtube';
import { fakeShell } from './helpers';

const X = 'UCxxxxxxxxxxxxxxxxxxxxxx';
const Y = 'UCyyyyyyyyyyyyyyyyyyyyyy';
const KAGAN: ChannelRef = { platform: 'youtube', id: X, handle: '@kagan.dunlap', name: 'Kagan Dunlap' };

test('parseChannel reads channel URLs, handles in any script, and IDs', () => {
  assert.deepEqual(parseChannel('https://www.youtube.com/@Kagan.Dunlap'), { platform: 'youtube', handle: '@kagan.dunlap' });
  assert.deepEqual(parseChannel('youtube.com/@KaganDunlap/videos'), { platform: 'youtube', handle: '@kagandunlap' });
  assert.deepEqual(parseChannel('@Brew'), { platform: 'youtube', handle: '@brew' });
  assert.deepEqual(parseChannel('https://www.youtube.com/@%E6%97%A5%E6%9C%AC%E8%AA%9E'), { platform: 'youtube', handle: '@日本語' });
  assert.deepEqual(parseChannel('@日本語チャンネル'), { platform: 'youtube', handle: '@日本語チャンネル' });
  assert.deepEqual(parseChannel(`https://www.youtube.com/channel/${X}`), { platform: 'youtube', id: X });
  assert.deepEqual(parseChannel(`  ${X} `), { platform: 'youtube', id: X });
});

test('parseChannel rejects what is not a channel, including malformed escapes', () => {
  for (const bad of ['', 'brew', 'https://www.youtube.com/watch?v=wIe3eDfGKUo', 'https://example.com/@brew', '@x', 'UCshort', 'youtube.com/@%E0']) {
    assert.equal(parseChannel(bad), null, bad);
  }
});

test('handleFromUrl reads the player response owner URL', () => {
  // As seen in the player response for 6gCWBSbzX-k on 2026-10-21.
  assert.equal(handleFromUrl('http://www.youtube.com/@kagan.dunlap'), '@kagan.dunlap');
  assert.equal(handleFromUrl('/@Brew/videos'), '@brew');
  assert.equal(handleFromUrl('http://www.youtube.com/channel/' + X), null);
});

test('channelUrl prefers the handle', () => {
  assert.equal(channelUrl(KAGAN), 'https://www.youtube.com/@kagan.dunlap');
  assert.equal(channelUrl({ platform: 'youtube', id: X }), `https://www.youtube.com/channel/${X}`);
});

test('an entry with an ID matches only that ID, never another channel showing the same handle', () => {
  const entry: ChannelRef = { platform: 'youtube', id: X, handle: '@foo' };
  assert.equal(entryMatches(entry, { platform: 'youtube', id: X, handle: '@foo' }), true);
  assert.equal(entryMatches(entry, { platform: 'youtube', id: Y, handle: '@foo' }), false);
  assert.equal(entryMatches(entry, { platform: 'youtube', handle: '@foo' }), false);
});

test('an entry typed as a handle matches on handle', () => {
  const entry: ChannelRef = { platform: 'youtube', handle: '@foo' };
  assert.equal(entryMatches(entry, { platform: 'youtube', id: Y, handle: '@foo' }), true);
  assert.equal(entryMatches(entry, { platform: 'youtube', id: Y }), false);
  assert.equal(entryMatches(entry, { platform: 'vimeo', handle: '@foo' }), false);
  assert.equal(isExcluded(null, [entry]), false);
});

test('needsHandle is true only with a handle-only entry for the platform', () => {
  assert.equal(needsHandle('youtube', [KAGAN]), false);
  assert.equal(needsHandle('youtube', [{ platform: 'youtube', handle: '@foo' }]), true);
  assert.equal(needsHandle('vimeo', [{ platform: 'youtube', handle: '@foo' }]), false);
});

test('upgradedEntry gives a matched handle-only entry its ID, and never rewrites an ID', () => {
  assert.deepEqual(upgradedEntry({ platform: 'youtube', handle: '@foo' }, { platform: 'youtube', id: Y, handle: '@foo', name: 'Foo' }), {
    platform: 'youtube',
    id: Y,
    handle: '@foo',
    name: 'Foo',
  });
  assert.equal(upgradedEntry({ platform: 'youtube', id: X, handle: '@foo' }, { platform: 'youtube', id: Y, handle: '@foo' }), null);
});

test('channelsFromItems reads only valid channel keys whose key matches the entry', () => {
  const items = {
    settings: { enabled: true },
    [channelKey(KAGAN)]: KAGAN,
    'xc:youtube:h:@brew': { platform: 'youtube', handle: 'Brew' },
    'xc:youtube:id:UCwrong': KAGAN,
    'xc:youtube:h:@bad': { platform: 'youtube' },
  };
  assert.deepEqual(channelsFromItems(items), [{ platform: 'youtube', handle: '@brew' }, KAGAN]);
});

test('an entry with all fields at their longest stays far under the 8 KB per-item quota', () => {
  const big: ChannelRef = { platform: 'youtube', id: X, handle: `@${'a'.repeat(30)}`, name: 'n'.repeat(60) };
  assert.ok(channelKey(big).length + JSON.stringify(big).length < 400);
});

test('ChannelStore adds, removes, and stores each channel under its own key', async () => {
  const shell = fakeShell();
  const store = new ChannelStore(shell);
  await store.add(KAGAN);
  await store.add({ platform: 'youtube', handle: '@brew' });
  assert.deepEqual(Object.keys(shell.items).sort(), [`xc:youtube:h:@brew`, `xc:youtube:id:${X}`]);
  await store.remove({ platform: 'youtube', id: X });
  assert.deepEqual(await store.list(), [{ platform: 'youtube', handle: '@brew' }]);
});

test('ChannelStore never overwrites an existing ID through a handle match', async () => {
  const shell = fakeShell();
  const store = new ChannelStore(shell);
  await store.add({ platform: 'youtube', id: X, handle: '@foo', name: 'X' });
  await store.add({ platform: 'youtube', id: Y, handle: '@foo', name: 'Y' });
  const list = await store.list();
  assert.deepEqual(list.map((c) => c.id).sort(), [X, Y]);
});

test('ChannelStore backfills a handle-only entry with the ID it matched, moving it to the ID key', async () => {
  const shell = fakeShell();
  const store = new ChannelStore(shell);
  await store.add({ platform: 'youtube', handle: '@kagan.dunlap' });
  await store.backfill(KAGAN, await store.list());
  assert.deepEqual(Object.keys(shell.items), [`xc:youtube:id:${X}`]);
  assert.deepEqual(await store.list(), [KAGAN]);
});

test('ChannelStore refuses to grow past the cap', async () => {
  const shell = fakeShell();
  const store = new ChannelStore(shell);
  for (let i = 0; i < MAX_EXCLUDED_CHANNELS; i++) shell.items[`xc:youtube:h:@c${i}xx`] = { platform: 'youtube', handle: `@c${i}xx` };
  await assert.rejects(store.add(KAGAN), ChannelListFullError);
  // Updating an existing entry still works when full.
  await store.add({ platform: 'youtube', handle: '@c1xx', name: 'C1' });
});

