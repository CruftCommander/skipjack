// Channels the user excluded from skipping. Platform-neutral: a channel is identified by the
// platform's own ID and, where the platform has one, a handle. Platform adapters produce and parse
// ChannelRefs; this module only compares them and maps them to storage keys.

/** A channel on some platform. At least one of `id` and `handle` is set. */
export interface ChannelRef {
  /** Platform adapter ID, for example `youtube`. */
  platform: string;
  /** The platform's stable channel ID, for example a YouTube `UC...` ID. */
  id?: string;
  /** The channel's handle, lowercase and with its leading `@`, for example `@kagandunlap`. */
  handle?: string;
  /** Display name, for the settings list only. Never used for matching. */
  name?: string;
}

/**
 * Each excluded channel is stored under its own synced-storage key, so the list is not bound by
 * the 8 KB per-item quota, and edits from two devices to different channels do not overwrite each
 * other. Synced storage allows 512 items and 100 KB in total; the settings use one item.
 */
export const CHANNEL_KEY_PREFIX = 'xc:';
export const MAX_EXCLUDED_CHANNELS = 250;
const MAX_NAME_LENGTH = 60;

function str(value: unknown, max = 100): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  return h.startsWith('@') ? h : `@${h}`;
}

/** Validates one stored entry. */
export function normalizeChannel(raw: unknown): ChannelRef | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const platform = str(r.platform, 40);
  const id = str(r.id);
  const handle = str(r.handle);
  if (!platform || (!id && !handle)) return null;
  const ch: ChannelRef = { platform };
  if (id) ch.id = id;
  if (handle) ch.handle = normalizeHandle(handle);
  const name = str(r.name, MAX_NAME_LENGTH);
  if (name) ch.name = name;
  return ch;
}

/** The storage key for an entry: by ID when it has one, else by handle. */
export function channelKey(ch: ChannelRef): string {
  return `${CHANNEL_KEY_PREFIX}${ch.platform}:${ch.id ? `id:${ch.id}` : `h:${ch.handle ?? ''}`}`;
}

export function isChannelKey(key: string): boolean {
  return key.startsWith(CHANNEL_KEY_PREFIX);
}

/** Reads every excluded channel out of a synced-storage snapshot, sorted by name. */
export function channelsFromItems(items: Record<string, unknown>): ChannelRef[] {
  const out: ChannelRef[] = [];
  for (const [key, value] of Object.entries(items)) {
    if (!isChannelKey(key)) continue;
    const ch = normalizeChannel(value);
    if (ch && channelKey(ch) === key) out.push(ch);
  }
  const label = (c: ChannelRef): string => (c.name ?? c.handle ?? c.id ?? '').toLowerCase();
  return out.sort((a, b) => label(a).localeCompare(label(b)));
}

/**
 * Whether a stored entry refers to the channel being viewed. An entry with an ID matches only that
 * ID: handles can be released and reclaimed, so a handle never overrides an ID. An entry the user
 * typed as a handle has no ID and matches on handle.
 */
export function entryMatches(entry: ChannelRef, channel: ChannelRef): boolean {
  if (entry.platform !== channel.platform) return false;
  if (entry.id) return entry.id === channel.id;
  return Boolean(entry.handle && entry.handle === channel.handle);
}

export function isExcluded(channel: ChannelRef | null, list: readonly ChannelRef[]): boolean {
  return channel ? list.some((e) => entryMatches(e, channel)) : false;
}

/** The excluded entry that matches the channel, if any. */
export function matchingEntry(channel: ChannelRef, list: readonly ChannelRef[]): ChannelRef | undefined {
  return list.find((e) => entryMatches(e, channel));
}

/**
 * True when the list has a handle-only entry for this platform, so a channel whose handle is not
 * known yet cannot be ruled out.
 */
export function needsHandle(platform: string, list: readonly ChannelRef[]): boolean {
  return list.some((e) => e.platform === platform && !e.id && e.handle);
}

/**
 * The stored form of `entry` once it has matched `seen`: a handle-only entry gains the channel's
 * ID and name, so later matches are by ID. Returns null when nothing would change.
 */
export function upgradedEntry(entry: ChannelRef, seen: ChannelRef): ChannelRef | null {
  if (entry.id || !seen.id || !entryMatches(entry, seen)) return null;
  return normalizeChannel({ ...entry, id: seen.id, name: seen.name ?? entry.name });
}
