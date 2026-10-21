// Runs in YouTube's own JavaScript world (manifest `"world": "MAIN"`), where the player's methods and
// page data are visible. It answers two kinds of question from the isolated content script:
//  1. What does the player hold? (video ID and channel), written to attributes on <html>.
//  2. What does this video say? (its transcript and signals for detection), posted back by message.
// It sends nothing off the page. The only requests it makes are caption requests to youtube.com that
// reuse the URL the player itself requested, as the step 1 probe did.

import {
  MIN_DETECT_SECONDS,
  parseJson3,
  PLAYER_LENGTH_ATTR,
  PLAYER_CHANNEL_HANDLE_ATTR,
  PLAYER_CHANNEL_ID_ATTR,
  PLAYER_CHANNEL_NAME_ATTR,
  PLAYER_QUERY_EVENT,
  PLAYER_VIDEO_ATTR,
  PROMO_LINE,
  TRANSCRIPT_CANCEL_EVENT,
  TRANSCRIPT_MESSAGE_SOURCE,
  TRANSCRIPT_REQUEST_ATTR,
  TRANSCRIPT_REQUEST_EVENT,
  type TranscriptReply,
  type TranscriptRequest,
} from './youtube';

interface PlayerResponse {
  videoDetails?: {
    videoId?: unknown;
    channelId?: unknown;
    author?: unknown;
    title?: unknown;
    lengthSeconds?: unknown;
    shortDescription?: unknown;
    isLive?: unknown;
    isLiveContent?: unknown;
  };
  microformat?: { playerMicroformatRenderer?: { ownerProfileUrl?: unknown } };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: unknown[] } };
}

interface YouTubePlayer extends HTMLElement {
  getVideoData?: () => { video_id?: unknown; author?: unknown } | undefined;
  getPlayerResponse?: () => PlayerResponse | undefined;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const player = (): YouTubePlayer | null => document.getElementById('movie_player') as YouTubePlayer | null;
const playingVideoId = (): string => text(player()?.getVideoData?.()?.video_id);

/** The media's length from the player response: the <video> element may be playing an ad. 0 for live. */
function lengthOf(response: PlayerResponse | undefined): number {
  const d = response?.videoDetails;
  if (!d || d.isLive === true || d.isLiveContent === true) return 0;
  const n = Number(text(d.lengthSeconds));
  return Number.isFinite(n) ? n : 0;
}

function set(name: string, value: string): void {
  const root = document.documentElement;
  if (root.getAttribute(name) !== value) root.setAttribute(name, value);
}

// ---------------------------------------------------------------------------------------------
// 1. What the player holds.

document.addEventListener(PLAYER_QUERY_EVENT, () => {
  let id = '';
  let channelId = '';
  let channelName = '';
  let channelHandle = '';
  let length = '';
  try {
    const p = player();
    const data = p?.getVideoData?.();
    id = text(data?.video_id);
    const response = p?.getPlayerResponse?.();
    const details = response?.videoDetails;
    // The player response can lag the video data for a moment after navigation, so it is only
    // used when it names the same video.
    if (details && id && text(details.videoId) === id) {
      channelId = text(details.channelId);
      channelName = text(details.author);
      // For example "http://www.youtube.com/@KaganDunlap". The adapter extracts the handle.
      channelHandle = text(response?.microformat?.playerMicroformatRenderer?.ownerProfileUrl);
      length = String(lengthOf(response));
    }
    if (!channelName) channelName = text(data?.author);
  } catch {
    // Unknown player shape: report unknown, which allows skips.
  }
  set(PLAYER_VIDEO_ATTR, id);
  set(PLAYER_CHANNEL_ID_ATTR, channelId);
  set(PLAYER_CHANNEL_NAME_ATTR, channelName.slice(0, 100));
  set(PLAYER_CHANNEL_HANDLE_ATTR, channelHandle.slice(0, 200));
  set(PLAYER_LENGTH_ATTR, length);
});

// ---------------------------------------------------------------------------------------------
// 2. The transcript.
//
// The caption URLs in the player response return an empty body unless they carry a proof-of-origin
// token that only the player adds, so the transcript comes from the URL the player itself requests.
// Resource timing reports every request the page makes, including the player's caption requests.

const playerCaptionUrls: string[] = [];
const ownFetches = new Set<string>();
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name.includes('/api/timedtext') && !ownFetches.has(entry.name)) playerCaptionUrls.push(entry.name);
    }
    // Keep only recent URLs; each video needs one.
    if (playerCaptionUrls.length > 50) playerCaptionUrls.splice(0, playerCaptionUrls.length - 50);
  }).observe({ type: 'resource', buffered: true });
} catch {
  // No resource timing: transcripts are unavailable, and the content script logs why.
}

function observedCaptionUrl(videoId: string): string | null {
  for (let i = playerCaptionUrls.length - 1; i >= 0; i--) {
    try {
      const url = playerCaptionUrls[i];
      if (url && new URL(url).searchParams.get('v') === videoId) return url;
    } catch {
      // Ignore an unparseable entry.
    }
  }
  return null;
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs: number, stepMs = 200): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | null | undefined | false = null;
    try {
      value = fn();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

/** Hides the caption overlay and returns a function that shows it again. */
function hideCaptionOverlay(): (() => void) | null {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.ytp-caption-window-container, .caption-window { visibility: hidden !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  } catch {
    return null;
  }
}

/**
 * Switches captions on for a moment, with the overlay hidden, so the player requests them, then puts
 * the viewer's setting back. Returns the URL the player requested, or null. Only the main player's
 * button is used: the hover-preview player has its own.
 */
async function toggleForCaptionUrl(videoId: string): Promise<string | null> {
  const button = player()?.querySelector<HTMLElement>('.ytp-subtitles-button');
  if (!button) return null;
  const isOn = (): boolean => button.getAttribute('aria-pressed') === 'true';
  const wasOn = isOn();
  if (wasOn) {
    // Captions are on but the player has not asked for this video's track yet: off and on again.
    button.click();
    await sleep(400);
  }
  const showOverlay = wasOn ? null : hideCaptionOverlay();
  try {
    if (!isOn()) button.click();
    return await waitFor(() => observedCaptionUrl(videoId), 6000, 100);
  } finally {
    // Compare rather than click blindly: the viewer or the player may have changed it meanwhile.
    if (isOn() !== wasOn) button.click();
    if (showOverlay) {
      await sleep(300);
      showOverlay();
    }
  }
}

// Page data (chapters) after in-site navigation comes with the navigation event; window.ytInitialData
// is only right for the first video loaded.
let navData: unknown = null;
document.addEventListener('yt-navigate-finish', (event) => {
  const detail = (event as CustomEvent<{ response?: { response?: unknown } }>).detail;
  navData = detail?.response?.response ?? null;
});

function findAll(root: unknown, key: string, limit = 5000): unknown[] {
  const out: unknown[] = [];
  const stack = [root];
  const seen = new Set<unknown>();
  while (stack.length && out.length < limit) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key) out.push(v);
      stack.push(v);
    }
  }
  return out;
}

function runsText(t: unknown): string {
  const r = t as { simpleText?: unknown; runs?: { text?: unknown }[] } | null;
  if (!r) return '';
  if (typeof r.simpleText === 'string') return r.simpleText;
  return Array.isArray(r.runs) ? r.runs.map((x) => text(x.text)).join('') : '';
}

function pageDataFor(videoId: string): unknown {
  const dataVideoId = (d: unknown): string | null =>
    text((d as { currentVideoEndpoint?: { watchEndpoint?: { videoId?: unknown } } } | null)?.currentVideoEndpoint?.watchEndpoint?.videoId) || null;
  const initial = (window as unknown as { ytInitialData?: unknown }).ytInitialData;
  for (const d of [navData, initial]) if (d && dataVideoId(d) === videoId) return d;
  // Never use another video's page data: its chapters would be applied to this video.
  return null;
}

function chaptersFor(videoId: string): { title: string; start: number }[] {
  const data = pageDataFor(videoId);
  if (!data) return [];
  const seen = new Set<string>();
  const out: { title: string; start: number }[] = [];
  for (const r of findAll(data, 'chapterRenderer') as { title?: unknown; timeRangeStartMillis?: unknown }[]) {
    const start = Number(r?.timeRangeStartMillis ?? 0) / 1000;
    const title = runsText(r?.title);
    const id = `${start}|${title}`;
    if (!Number.isFinite(start) || seen.has(id)) continue;
    seen.add(id);
    out.push({ title, start });
  }
  return out.sort((a, b) => a.start - b.start);
}

// One capture at a time, and only the newest request counts: two toggles at once would fight over
// the captions button, and a request for a video the viewer has left must not touch the next one.
let busy: Promise<void> = Promise.resolve();
let latest: string | null = null;

document.addEventListener(TRANSCRIPT_CANCEL_EVENT, () => {
  latest = null;
});

document.addEventListener(TRANSCRIPT_REQUEST_EVENT, () => {
  let request: TranscriptRequest;
  try {
    request = JSON.parse(document.documentElement.getAttribute(TRANSCRIPT_REQUEST_ATTR) ?? '');
  } catch {
    return;
  }
  if (!request || typeof request.nonce !== 'string' || typeof request.videoId !== 'string') return;
  latest = request.nonce;
  busy = busy.then(() =>
    capture(request).then(post, (error: unknown) =>
      post({ source: TRANSCRIPT_MESSAGE_SOURCE, nonce: request.nonce, ok: false, videoId: request.videoId, reason: String(error), retry: true }),
    ),
  );
});

function post(reply: TranscriptReply): void {
  window.postMessage(reply, location.origin);
}

async function capture(req: TranscriptRequest): Promise<TranscriptReply> {
  const fail = (reason: string, retry: boolean): TranscriptReply => ({
    source: TRANSCRIPT_MESSAGE_SOURCE,
    nonce: req.nonce,
    ok: false,
    videoId: req.videoId,
    reason,
    retry,
  });
  // Still wanted, and the player still holds this video.
  const current = (): boolean => latest === req.nonce && playingVideoId() === req.videoId;

  if (latest !== req.nonce) return fail('superseded by a newer request', false);
  const found = await waitFor(() => {
    const response = player()?.getPlayerResponse?.();
    return response && text(response.videoDetails?.videoId) === req.videoId ? response : null;
  }, 15000);
  if (!found) return fail('the player never loaded this video', true);

  // Decide from the player response, before touching anything: the <video> element's own duration
  // may belong to an ad or to the previous video.
  const length = lengthOf(found);
  if (length === 0) return fail('live streams are not analyzed', false);
  if (length < MIN_DETECT_SECONDS) return fail(`shorter than ${MIN_DETECT_SECONDS} seconds`, false);
  const tracks = found.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return fail('this video has no captions', false);

  // The player does not request the video's captions while it plays its own ad.
  const adShowing = () => Boolean(player()?.classList.contains('ad-showing'));
  if (adShowing()) await waitFor(() => !adShowing() || latest !== req.nonce, 90000, 500);
  if (!current()) return fail('the viewer moved on', false);
  if (adShowing()) return fail('an ad was still playing', true);

  let url = observedCaptionUrl(req.videoId);
  if (!url && req.allowToggle && current()) url = await toggleForCaptionUrl(req.videoId);
  // Without the toggle, wait briefly in case the viewer has captions on.
  if (!url) url = await waitFor(() => observedCaptionUrl(req.videoId), req.allowToggle ? 1000 : 5000);
  if (latest !== req.nonce) return fail('superseded by a newer request', false);
  if (!url) return fail('the player made no caption request', true);

  const fetchUrl = new URL(url, location.origin);
  fetchUrl.searchParams.set('fmt', 'json3');
  ownFetches.add(fetchUrl.href);
  const response = await fetch(fetchUrl.href, { credentials: 'include' });
  const cues = parseJson3(await response.text());
  if (cues.length === 0) return fail(`the caption request returned no cues (HTTP ${response.status})`, true);
  if (latest !== req.nonce) return fail('superseded by a newer request', false);

  const details = found.videoDetails ?? {};
  const description = text(details.shortDescription);
  return {
    source: TRANSCRIPT_MESSAGE_SOURCE,
    nonce: req.nonce,
    ok: true,
    videoId: req.videoId,
    title: text(details.title),
    lengthSeconds: length,
    cues,
    chapters: chaptersFor(req.videoId).slice(0, 100),
    paidPromotion: findAll(found, 'paidContentOverlayRenderer', 1).length > 0,
    promoLines: description
      .split(/\r?\n/)
      .filter((l) => PROMO_LINE.test(l))
      .slice(0, 10)
      .map((l) => l.slice(0, 200)),
    track: { lang: fetchUrl.searchParams.get('lang'), kind: fetchUrl.searchParams.get('kind') },
  };
}
