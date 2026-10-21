// YouTube adapter. Every YouTube quirk stays in this file and youtube-main.ts.

import { normalizeHandle, type ChannelRef } from '../core/channels';
import type { ChannelSyntax, PlatformAdapter } from './platform';

export const YOUTUBE_ID = 'youtube';

/** Shared with youtube-main.ts, which runs in the page's own JavaScript world. */
export const PLAYER_QUERY_EVENT = 'skipjack:yt-player-query';
export const PLAYER_VIDEO_ATTR = 'data-skipjack-player-video';
export const PLAYER_CHANNEL_ID_ATTR = 'data-skipjack-channel-id';
export const PLAYER_CHANNEL_NAME_ATTR = 'data-skipjack-channel-name';
export const PLAYER_CHANNEL_HANDLE_ATTR = 'data-skipjack-channel-handle';

const HOSTS = new Set(['www.youtube.com', 'm.youtube.com', 'youtube.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
/** YouTube handles: 3 to 30 letters or digits in any script, plus `.`, `_`, `-`, and `·`. */
const HANDLE = /^@?([\p{L}\p{M}\p{N}._\-\u00B7]{3,30})$/u;
const POLL_MS = 1000;

function validId(id: string | null | undefined): string | null {
  return id && VIDEO_ID.test(id) ? id : null;
}

export function youtubeMediaIdFromUrl(url: URL): string | null {
  if (!HOSTS.has(url.hostname)) return null;
  if (url.pathname === '/watch') return validId(url.searchParams.get('v'));
  // Live streams and premieres have a /live/<id> form. Shorts are left alone on purpose: they loop,
  // and a skip inside one is more disruptive than the pitch.
  const live = /^\/live\/([^/?#]+)/.exec(url.pathname);
  if (live) return validId(live[1]);
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The handle in a channel URL like `http://www.youtube.com/@Name` or a path like `/@Name`. */
export function handleFromUrl(url: string): string | null {
  const m = /(?:^|youtube\.com)\/(@[^/?#]+)/.exec(url);
  const h = m?.[1] ? HANDLE.exec(safeDecode(m[1])) : null;
  return h?.[1] ? normalizeHandle(h[1]) : null;
}

/** Reads a YouTube channel from a pasted URL, @handle, or UC... ID. */
export function parseYouTubeChannel(input: string): ChannelRef | null {
  const text = input.trim();
  if (!text) return null;
  if (CHANNEL_ID.test(text)) return { platform: YOUTUBE_ID, id: text };
  let url: URL | null = null;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    url = null;
  }
  if (url && HOSTS.has(url.hostname)) {
    const [first, second] = url.pathname.split('/').filter(Boolean);
    if (first === 'channel' && second && CHANNEL_ID.test(second)) return { platform: YOUTUBE_ID, id: second };
    if (first?.startsWith('@')) {
      const m = HANDLE.exec(safeDecode(first));
      if (m?.[1]) return { platform: YOUTUBE_ID, handle: normalizeHandle(m[1]) };
    }
    return null;
  }
  const m = HANDLE.exec(text);
  // A bare word is only a handle when written with its @, so a typo is not saved as one.
  return m?.[1] && text.startsWith('@') ? { platform: YOUTUBE_ID, handle: normalizeHandle(m[1]) } : null;
}

export const youtubeChannelSyntax: ChannelSyntax = {
  platform: YOUTUBE_ID,
  parseChannel: parseYouTubeChannel,
  channelUrl: (ch) =>
    ch.handle ? `https://www.youtube.com/${ch.handle}` : ch.id ? `https://www.youtube.com/channel/${ch.id}` : null,
};

export function createYouTubeAdapter(doc: Document = document, win: Window = window): PlatformAdapter {
  /**
   * Asks youtube-main.ts, in the page's own world, what the player holds. The event is dispatched
   * synchronously, so the attributes are current when they are read. Empty means unknown.
   */
  const queryPlayer = (): { video: string | null; channelId: string | null; channelName: string | null; channelHandle: string | null } => {
    doc.dispatchEvent(new CustomEvent(PLAYER_QUERY_EVENT));
    const root = doc.documentElement;
    return {
      video: root.getAttribute(PLAYER_VIDEO_ATTR) || null,
      channelId: root.getAttribute(PLAYER_CHANNEL_ID_ATTR) || null,
      channelName: root.getAttribute(PLAYER_CHANNEL_NAME_ATTR) || null,
      channelHandle: root.getAttribute(PLAYER_CHANNEL_HANDLE_ATTR) || null,
    };
  };

  return {
    id: YOUTUBE_ID,
    capabilities: { communitySegments: true, transcript: true },

    matches: (url) => HOSTS.has(url.hostname),

    mediaIdFromUrl: youtubeMediaIdFromUrl,

    watchMedia(onChange) {
      let last: string | null | undefined;
      const emit = (): void => {
        const id = youtubeMediaIdFromUrl(new URL(win.location.href));
        if (id === last) return;
        last = id;
        onChange(id);
      };
      // yt-navigate-finish covers desktop in-site navigation. The poll covers the mobile site and any
      // navigation path that does not fire it.
      doc.addEventListener('yt-navigate-finish', emit);
      win.addEventListener('popstate', emit);
      const timer = win.setInterval(emit, POLL_MS);
      emit();
      return () => {
        doc.removeEventListener('yt-navigate-finish', emit);
        win.removeEventListener('popstate', emit);
        win.clearInterval(timer);
      };
    },

    findMediaElement() {
      return (
        doc.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ??
        doc.querySelector<HTMLVideoElement>('#movie_player video') ??
        doc.querySelector<HTMLVideoElement>('video.html5-main-video')
      );
    },

    canSkipNow(mediaId) {
      // YouTube plays its own ads in the same <video> element. Never seek during one.
      const player = doc.getElementById('movie_player');
      if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) return false;

      // After in-site navigation the URL changes before the player switches videos. Ask the player
      // which video it holds. Unknown allows the skip.
      const playing = queryPlayer().video;
      return !playing || playing === mediaId;
    },

    channelOf(mediaId) {
      const player = queryPlayer();
      // Only trust the player's answer for the media we were asked about. youtube-main.ts reads
      // the channel from the player response only when it is for this same video.
      if (player.video !== mediaId) return null;
      const channel: ChannelRef = { platform: YOUTUBE_ID };
      if (player.channelId && CHANNEL_ID.test(player.channelId)) channel.id = player.channelId;
      if (player.channelName) channel.name = player.channelName;
      const handle = player.channelHandle ? handleFromUrl(player.channelHandle) : null;
      if (handle) channel.handle = handle;
      return channel.id || channel.handle ? channel : null;
    },

    overlayHost() {
      return doc.getElementById('movie_player') ?? doc.body;
    },
  };
}
