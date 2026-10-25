// YouTube adapter. Every YouTube quirk stays in this file and youtube-main.ts.

import { normalizeHandle, type ChannelRef } from '../core/channels';
import { MAX_CHAPTERS, MAX_CUES, MAX_DURATION_SECONDS, MAX_PROMO_LINES, MAX_TRANSCRIPT_CHARS } from '../core/messages';
import { MIN_DETECTION_SECONDS } from '../core/sources';
import type { ChannelSyntax, PlatformAdapter, TranscriptResult } from './platform';

export const YOUTUBE_ID = 'youtube';

/** Shared with youtube-main.ts, which runs in the page's own JavaScript world. */
export const PLAYER_QUERY_EVENT = 'skipjack:yt-player-query';
export const PLAYER_VIDEO_ATTR = 'data-skipjack-player-video';
export const PLAYER_CHANNEL_ID_ATTR = 'data-skipjack-channel-id';
export const PLAYER_CHANNEL_NAME_ATTR = 'data-skipjack-channel-name';
export const PLAYER_CHANNEL_HANDLE_ATTR = 'data-skipjack-channel-handle';
export const PLAYER_LENGTH_ATTR = 'data-skipjack-length';
export const MIN_DETECT_SECONDS = MIN_DETECTION_SECONDS;
/** Transcript requests: the isolated script writes the request here, then fires the event. */
export const TRANSCRIPT_CANCEL_EVENT = 'skipjack:yt-transcript-cancel';
export const TRANSCRIPT_REQUEST_EVENT = 'skipjack:yt-transcript-request';
export const TRANSCRIPT_REQUEST_ATTR = 'data-skipjack-transcript-request';
/** The page-world script answers with window.postMessage, tagged with this source. */
export const TRANSCRIPT_MESSAGE_SOURCE = 'skipjack-yt-transcript';

export interface TranscriptRequest {
  nonce: string;
  videoId: string;
  allowToggle: boolean;
}

/** What youtube-main.ts posts back. Cues are [startSeconds, durationSeconds, text]. */
export type TranscriptReply =
  | {
      source: typeof TRANSCRIPT_MESSAGE_SOURCE;
      nonce: string;
      ok: true;
      videoId: string;
      title: string;
      lengthSeconds: number;
      cues: [number, number, string][];
      chapters: { title: string; start: number }[];
      paidPromotion: boolean;
      promoLines: string[];
      track: { lang: string | null; kind: string | null };
    }
  | { source: typeof TRANSCRIPT_MESSAGE_SOURCE; nonce: string; ok: false; videoId: string; reason: string; retry: boolean };

/**
 * The media's length in seconds from the player response's `videoDetails`, or 0 for a stream that is
 * live now. The <video> element's own duration may belong to an ad, so youtube-main.ts uses this.
 *
 * Only `isLive` means live. `isLiveContent` stays true on the finished recording of a stream, which
 * has a real length and captions and is analyzed like any other video. A missing, zero, or
 * malformed `lengthSeconds` is also treated as live, because there is no end to plan skips against.
 */
export function playerMediaLength(details: { lengthSeconds?: unknown; isLive?: unknown } | undefined): number {
  if (!details || details.isLive === true) return 0;
  const raw = details.lengthSeconds;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Whether to switch captions back after the brief toggle. Skipjack restores the viewer's setting only
 * if captions are still where it left them. If the viewer changed them during the switch, by the
 * captions button, the settings menu, or the C key, the viewer's choice stands.
 *
 * `leftOn` is the state right after Skipjack's own clicks, read back from the button rather than
 * assumed, so a click the player ignored is never "restored" over the viewer's change.
 */
export function shouldRestoreCaptions(s: { wasOn: boolean; leftOn: boolean; nowOn: boolean; viewerTouched: boolean }): boolean {
  return !s.viewerTouched && s.leftOn !== s.wasOn && s.nowOn === s.leftOn;
}

/** True when a caption URL carries the proof-of-origin token (`pot`) that only the player adds. */
export function hasProofOfOrigin(url: string): boolean {
  try {
    return Boolean(new URL(url).searchParams.get('pot'));
  } catch {
    return false;
  }
}

/**
 * The caption URLs seen on the page that are worth trying for `videoId`, best first: those with the
 * player's proof-of-origin token, newest first, then any others, newest first. Another script on the
 * page, such as the step 1 probe, can request the same track without the token, and that request
 * returns an empty body. `urls` is in the order the requests were seen.
 */
export function captionCandidates(urls: readonly string[], videoId: string, limit = 3): string[] {
  const withToken: string[] = [];
  const without: string[] = [];
  const seen = new Set<string>();
  for (let i = urls.length - 1; i >= 0; i--) {
    const raw = urls[i];
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.searchParams.get('v') !== videoId) continue;
    (hasProofOfOrigin(raw) ? withToken : without).push(raw);
  }
  return [...withToken, ...without].slice(0, Math.max(0, limit));
}

/** Parses YouTube's json3 caption format into [startSeconds, durationSeconds, text] cues. */
export function parseJson3(body: string): [number, number, string][] {
  let json: { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const out: [number, number, string][] = [];
  for (const e of json.events ?? []) {
    if (!Array.isArray(e.segs)) continue;
    const text = e.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push([(e.tStartMs ?? 0) / 1000, (e.dDurationMs ?? 0) / 1000, text]);
  }
  return out;
}

/** Description lines that look promotional. A hint for detection, never proof. */
export const PROMO_LINE = /\b(sponsor\w*|promo(tion)?\s*code|coupon|discount|use (the )?code|\d{1,3}\s?% off|free trial|affiliate|paid promotion)\b/i;

const HOSTS = new Set(['www.youtube.com', 'm.youtube.com', 'youtube.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
/** YouTube handles: 3 to 30 letters or digits in any script, plus `.`, `_`, `-`, and `·`. */
const HANDLE = /^@?([\p{L}\p{M}\p{N}._\-\u00B7]{3,30})$/u;
const POLL_MS = 1000;
/** Longest wait for the page-world script's answer: it may wait out an ad of up to 90 s. */
const TRANSCRIPT_TIMEOUT_MS = 120_000;
/**
 * Limits on what the page may hand over. The page writes the transcript, so these bound what a
 * misbehaving page could make detection spend. 400,000 characters is about 7 hours of speech.
 */

/**
 * Validates and converts the page-world script's reply. Throws on a malformed one. Exported for
 * tests, which check that what it lets through always passes the background's isDetectRequest.
 */
export function toResult(r: TranscriptReply, mediaId: string): TranscriptResult {
  if (!r.ok) return { ok: false, reason: String(r.reason).slice(0, 200), retry: Boolean(r.retry) };
  if (r.videoId !== mediaId || !Array.isArray(r.cues)) throw new Error('mismatched reply');
  const length = Number(r.lengthSeconds);
  if (!Number.isFinite(length) || length < MIN_DETECTION_SECONDS) return { ok: false, reason: 'too short or live', retry: false };
  if (length > MAX_DURATION_SECONDS) return { ok: false, reason: 'longer than any video Skipjack analyzes', retry: false };
  // Kept within the limits the background script checks (isDetectRequest), so a real transcript is
  // never refused there.
  const transcript: { start: number; duration: number; text: string }[] = [];
  let chars = 0;
  for (const c of r.cues) {
    if (!Array.isArray(c) || c.length !== 3) continue;
    const [start, duration, text] = [Number(c[0]), Number(c[1]), String(c[2]).slice(0, 1000)];
    if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || start > length + 60) continue;
    chars += text.length;
    if (chars > MAX_TRANSCRIPT_CHARS || transcript.length >= MAX_CUES) return { ok: false, reason: 'transcript too long', retry: false };
    transcript.push({ start, duration: Math.min(Math.max(duration, 0), 3600), text });
  }
  if (transcript.length === 0) return { ok: false, reason: 'empty transcript', retry: true };
  const chapters = (Array.isArray(r.chapters) ? r.chapters : [])
    .slice(0, MAX_CHAPTERS)
    .map((c) => ({ title: String(c?.title ?? '').slice(0, 200), start: Number(c?.start) }))
    .filter((c) => Number.isFinite(c.start) && c.start >= 0 && c.start <= length);
  return {
    ok: true,
    input: {
      media: { platform: YOUTUBE_ID, id: mediaId },
      title: String(r.title ?? '').slice(0, 300),
      durationSeconds: length,
      transcript,
      signals: {
        chapters,
        paidPromotion: r.paidPromotion === true,
        descriptionPromoLines: (Array.isArray(r.promoLines) ? r.promoLines : []).slice(0, MAX_PROMO_LINES).map((l) => String(l).slice(0, 200)),
      },
    },
  };
}

function isReply(data: unknown, nonce: string): data is TranscriptReply {
  const d = data as Partial<TranscriptReply> | null;
  return !!d && typeof d === 'object' && d.source === TRANSCRIPT_MESSAGE_SOURCE && d.nonce === nonce;
}

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
  const queryPlayer = (): {
    video: string | null;
    channelId: string | null;
    channelName: string | null;
    channelHandle: string | null;
    length: string | null;
  } => {
    doc.dispatchEvent(new CustomEvent(PLAYER_QUERY_EVENT));
    const root = doc.documentElement;
    return {
      video: root.getAttribute(PLAYER_VIDEO_ATTR) || null,
      channelId: root.getAttribute(PLAYER_CHANNEL_ID_ATTR) || null,
      channelName: root.getAttribute(PLAYER_CHANNEL_NAME_ATTR) || null,
      channelHandle: root.getAttribute(PLAYER_CHANNEL_HANDLE_ATTR) || null,
      length: root.getAttribute(PLAYER_LENGTH_ATTR) || null,
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

    lengthOf(mediaId) {
      // From the player response for this video: the <video> element may be playing an ad.
      const player = queryPlayer();
      if (player.video !== mediaId || player.length === null) return null;
      const n = Number(player.length);
      return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
    },

    cancelTranscript() {
      doc.dispatchEvent(new CustomEvent(TRANSCRIPT_CANCEL_EVENT));
    },

    readTranscript(mediaId, { allowToggle }): Promise<TranscriptResult> {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      return new Promise<TranscriptResult>((resolve) => {
        const done = (result: TranscriptResult): void => {
          win.removeEventListener('message', onMessage);
          win.clearTimeout(timer);
          resolve(result);
        };
        const onMessage = (event: MessageEvent): void => {
          if (event.source !== win || !isReply(event.data, nonce)) return;
          try {
            done(toResult(event.data, mediaId));
          } catch {
            done({ ok: false, reason: 'malformed transcript reply', retry: false });
          }
        };
        const timer = win.setTimeout(() => done({ ok: false, reason: 'no answer from the page', retry: true }), TRANSCRIPT_TIMEOUT_MS);
        win.addEventListener('message', onMessage);
        const request: TranscriptRequest = { nonce, videoId: mediaId, allowToggle };
        doc.documentElement.setAttribute(TRANSCRIPT_REQUEST_ATTR, JSON.stringify(request));
        doc.dispatchEvent(new CustomEvent(TRANSCRIPT_REQUEST_EVENT));
      });
    },

    overlayHost() {
      return doc.getElementById('movie_player') ?? doc.body;
    },
  };
}
