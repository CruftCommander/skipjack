// YouTube adapter. Every YouTube quirk stays in this file and youtube-main.ts.

import type { PlatformAdapter } from './platform';

export const YOUTUBE_ID = 'youtube';

/** Shared with youtube-main.ts, which runs in the page's own JavaScript world. */
export const PLAYER_QUERY_EVENT = 'skipjack:yt-player-query';
export const PLAYER_VIDEO_ATTR = 'data-skipjack-player-video';

const HOSTS = new Set(['www.youtube.com', 'm.youtube.com', 'youtube.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
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

export function createYouTubeAdapter(doc: Document = document, win: Window = window): PlatformAdapter {
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

      // After in-site navigation the URL changes before the player switches videos. Ask the player,
      // through the page-world helper, which video it holds. The event is dispatched synchronously,
      // so the attribute is current when this line reads it. Empty means unknown: allow the skip.
      doc.dispatchEvent(new CustomEvent(PLAYER_QUERY_EVENT));
      const playing = doc.documentElement.getAttribute(PLAYER_VIDEO_ATTR);
      return !playing || playing === mediaId;
    },

    overlayHost() {
      return doc.getElementById('movie_player') ?? doc.body;
    },
  };
}
