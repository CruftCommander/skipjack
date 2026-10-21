// Reads and writes the excluded-channel list through the browser shell. Each channel is its own
// synced-storage item; see CHANNEL_KEY_PREFIX in core/channels.ts.

import {
  channelKey,
  channelsFromItems,
  entryMatches,
  isChannelKey,
  matchingEntry,
  MAX_EXCLUDED_CHANNELS,
  normalizeChannel,
  upgradedEntry,
  type ChannelRef,
} from '../core/channels';
import type { BrowserShell } from './shell';

export class ChannelListFullError extends Error {
  constructor() {
    super(`The list is full (${MAX_EXCLUDED_CHANNELS} channels). Remove one first.`);
  }
}

export class ChannelStore {
  constructor(private readonly shell: BrowserShell) {}

  async list(): Promise<ChannelRef[]> {
    return channelsFromItems(await this.shell.getAllSynced());
  }

  /** Excludes a channel. An entry that already matches it is filled in with any new details. */
  async add(channel: ChannelRef): Promise<void> {
    const ch = normalizeChannel(channel);
    if (!ch) throw new Error('Not a valid channel.');
    const list = await this.list();
    const existing = matchingEntry(ch, list) ?? list.find((e) => channelKey(e) === channelKey(ch));
    if (existing) {
      const merged = upgradedEntry(existing, ch) ?? normalizeChannel({ ...existing, name: ch.name ?? existing.name });
      if (merged) await this.replace(existing, merged);
      return;
    }
    if (list.length >= MAX_EXCLUDED_CHANNELS) throw new ChannelListFullError();
    await this.shell.setSyncedItems({ [channelKey(ch)]: ch });
  }

  /** Stops excluding a channel: removes every entry that matches it. */
  async remove(channel: ChannelRef): Promise<void> {
    const list = await this.list();
    const keys = list.filter((e) => entryMatches(e, channel) || channelKey(e) === channelKey(channel)).map(channelKey);
    if (keys.length > 0) await this.shell.removeSynced(keys);
  }

  /**
   * Gives a handle-only entry the ID of the channel it just matched, so later matches are by ID and
   * no longer depend on the handle. Does nothing for entries that already have an ID.
   */
  async backfill(seen: ChannelRef, list: readonly ChannelRef[]): Promise<void> {
    const entry = matchingEntry(seen, list);
    const upgraded = entry ? upgradedEntry(entry, seen) : null;
    if (entry && upgraded) await this.replace(entry, upgraded);
  }

  /** Calls `listener` with the new list whenever any excluded-channel item changes. */
  onChanged(listener: (list: ChannelRef[]) => void): void {
    this.shell.onSyncedKeysChanged((keys) => {
      if (keys.some(isChannelKey)) void this.list().then(listener);
    });
  }

  private async replace(old: ChannelRef, next: ChannelRef): Promise<void> {
    const oldKey = channelKey(old);
    const newKey = channelKey(next);
    await this.shell.setSyncedItems({ [newKey]: next });
    if (oldKey !== newKey) await this.shell.removeSynced([oldKey]);
  }
}
