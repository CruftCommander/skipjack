import type { ChannelRef } from '../core/channels';
import type { ChannelSyntax, PlatformAdapter } from './platform';
import { createYouTubeAdapter, youtubeChannelSyntax } from './youtube';

/** Every platform adapter. Add new ones here. */
export function platformAdapters(): PlatformAdapter[] {
  return [createYouTubeAdapter()];
}

export function adapterFor(url: URL): PlatformAdapter | null {
  return platformAdapters().find((a) => a.matches(url)) ?? null;
}

/** Channel syntax for every platform. Add new ones here. */
export const channelSyntaxes: readonly ChannelSyntax[] = [youtubeChannelSyntax];

/** Reads a channel from whatever a user pasted, trying every platform. */
export function parseChannel(input: string): ChannelRef | null {
  for (const s of channelSyntaxes) {
    const ch = s.parseChannel(input);
    if (ch) return ch;
  }
  return null;
}

export function channelUrl(channel: ChannelRef): string | null {
  return channelSyntaxes.find((s) => s.platform === channel.platform)?.channelUrl(channel) ?? null;
}
