// Runs in YouTube's own JavaScript world (manifest `"world": "MAIN"`), where the player's methods are
// visible. It does one thing: on request, writes the ID of the video the player holds to an attribute
// that the isolated content script can read. It sends nothing anywhere.

import { PLAYER_QUERY_EVENT, PLAYER_VIDEO_ATTR } from './youtube';

interface YouTubePlayer extends HTMLElement {
  getVideoData?: () => { video_id?: unknown } | undefined;
}

document.addEventListener(PLAYER_QUERY_EVENT, () => {
  let id = '';
  try {
    const player = document.getElementById('movie_player') as YouTubePlayer | null;
    const data = player?.getVideoData?.();
    if (data && typeof data.video_id === 'string') id = data.video_id;
  } catch {
    // Unknown player shape: report unknown, which allows skips.
  }
  const root = document.documentElement;
  if (root.getAttribute(PLAYER_VIDEO_ATTR) !== id) root.setAttribute(PLAYER_VIDEO_ATTR, id);
});
