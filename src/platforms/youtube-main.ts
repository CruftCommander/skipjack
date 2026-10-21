// Runs in YouTube's own JavaScript world (manifest `"world": "MAIN"`), where the player's methods are
// visible. It does one thing: on request, writes what the player holds (the video ID and its channel)
// to attributes that the isolated content script can read. It sends nothing anywhere.

import {
  PLAYER_CHANNEL_HANDLE_ATTR,
  PLAYER_CHANNEL_ID_ATTR,
  PLAYER_CHANNEL_NAME_ATTR,
  PLAYER_QUERY_EVENT,
  PLAYER_VIDEO_ATTR,
} from './youtube';

interface YouTubePlayer extends HTMLElement {
  getVideoData?: () => { video_id?: unknown; author?: unknown } | undefined;
  getPlayerResponse?: () =>
    | {
        videoDetails?: { videoId?: unknown; channelId?: unknown; author?: unknown };
        microformat?: { playerMicroformatRenderer?: { ownerProfileUrl?: unknown } };
      }
    | undefined;
}

function set(name: string, value: string): void {
  const root = document.documentElement;
  if (root.getAttribute(name) !== value) root.setAttribute(name, value);
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

document.addEventListener(PLAYER_QUERY_EVENT, () => {
  let id = '';
  let channelId = '';
  let channelName = '';
  let channelHandle = '';
  try {
    const player = document.getElementById('movie_player') as YouTubePlayer | null;
    const data = player?.getVideoData?.();
    id = text(data?.video_id);
    const response = player?.getPlayerResponse?.();
    const details = response?.videoDetails;
    // The player response can lag the video data for a moment after navigation, so it is only
    // used when it names the same video.
    if (details && id && text(details.videoId) === id) {
      channelId = text(details.channelId);
      channelName = text(details.author);
      // For example "http://www.youtube.com/@KaganDunlap". The adapter extracts the handle.
      channelHandle = text(response?.microformat?.playerMicroformatRenderer?.ownerProfileUrl);
    }
    if (!channelName) channelName = text(data?.author);
  } catch {
    // Unknown player shape: report unknown, which allows skips.
  }
  set(PLAYER_VIDEO_ATTR, id);
  set(PLAYER_CHANNEL_ID_ATTR, channelId);
  set(PLAYER_CHANNEL_NAME_ATTR, channelName.slice(0, 100));
  set(PLAYER_CHANNEL_HANDLE_ATTR, channelHandle.slice(0, 200));
});
