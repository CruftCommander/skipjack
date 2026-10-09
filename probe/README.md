# Skipjack probe

The probe is the step 1 spike. It answers one question before any real extension code exists: which sponsor-detection signals can a content script read on a YouTube watch page ahead of playback?

The probe reads only. It skips nothing and keeps no data of its own. Every request it makes is a caption or transcript request addressed to `youtube.com`. If YouTube redirects a caption request, for example to a verification page when it rate-limits you, the probe follows the redirect and records the host it ended on, so a request can reach another Google host. A report leaves the page only when you select **Download JSON**, **Download + transcript**, or **Copy JSON**. Only **Download + transcript** includes the video's full caption text.

To make the player request captions, the probe clicks YouTube's own captions button and then clicks it again to restore your setting. YouTube might record that as a caption preference change.

## What the probe checks

| Signal | How the probe reads it |
| --- | --- |
| Captions, route A | Fetches the caption track URL from the player response. |
| Captions, route B | Reuses the caption URL the player itself requests. If the player has not requested captions, the probe switches captions on for a moment, hides the caption overlay while they are on, and then restores your setting. |
| Caption token reuse | Copies the token from the player's caption URL onto another track's URL, to see whether one player request unlocks every track. |
| Captions, route C | Calls the endpoint behind the **Show transcript** panel. The request carries your normal `youtube.com` cookies but no `Authorization` header. |
| Chapters | Creator and automatic chapters, plus any chapter whose title names a sponsor or ad. |
| Paid promotion flag | The "Includes paid promotion" overlay in the player data. |
| Heatmap | The "most replayed" markers in the page data, and the graph the player draws in its own DOM. |
| Description | Links, promo-code lines, and timestamp lines. |
| Storyboards | The preview-thumbnail spec and its resolution levels. |

The transcript is the go/no-go gate. The project continues as designed if at least one caption route reports `OK` on most captioned videos.

## Load the probe

1. In Chrome, open `chrome://extensions`. In Edge, open `edge://extensions`.
1. Turn on **Developer mode**.
1. Select **Load unpacked**, and then choose the `probe` folder of your clone.
1. Open a YouTube video. A panel appears in the lower-right corner within a few seconds.

The probe requires Chrome or Edge 111 or later. After you change a probe file, select the reload icon on its card on the extensions page, and then reload the YouTube tab.

To remove the probe, select **Remove** on its card on the extensions page.

## Collect reports

Run the probe on 10 videos that cover these cases:

1. A video with creator-uploaded captions.
1. A video with only auto-generated captions.
1. A video with no captions.
1. A video with a chapter labeled as a sponsor or ad.
1. A video that shows "Includes paid promotion" at the start.
1. A video with more than a million views.
1. A video uploaded within the last day, from a small channel.
1. A video longer than one hour.
1. A video in a language other than English.
1. An age-restricted video.

On each video, select **Download JSON**, and then move the file into `probe/reports` in your clone. The repository's `.gitignore` excludes that folder, because each report names a video you watched.

Open the second or third video by clicking a link inside YouTube instead of loading the page fresh. That exercises in-site navigation, which is where stale page data shows up.

If the probe finds only page data for a different video, it sets `initialData.matchesVideo` to `false`, skips route C, and marks chapters and the heatmap as unavailable instead of reporting the previous video's values. Reload the page and select **Rerun**.

If an ad is playing, the probe waits up to 90 seconds for it to end. `adStillShowing` is `true` when it did not, and caption results in that report are unreliable.

## Test the captions toggle

The extension has to switch captions on for a moment to make the player request them. The toggle test checks whether a viewer can see that happen.

1. Turn captions off, and play a part of the video where someone is speaking.
1. Select **Toggle test (visible)**, or press Alt+Shift+J. Captions show for one second. This is the control: it shows what an unhidden flash looks like.
1. Select **Toggle test (hidden)**, or press Alt+Shift+K. Captions are on for one second with the overlay hidden. Watch the video and the captions button.
1. Repeat the hidden test in fullscreen and in theater mode, using the shortcut.

The note under the buttons reports each run. A run counts only if it says a caption line was present. The results are saved in the next report you download, under `toggleTests`.

## Read a report

- `captions.usableRoutes` lists the caption routes that returned cues.
- `captions.directFetch.reason` is `empty body` when the URL returned nothing. The likely cause is a proof-of-origin token (`pot`) that the URL lacks; `hasPot` shows whether the URL carried one.
- `captions.directFetch.redirected` and `captions.playerRequest.redirected` are `true` when YouTube redirected the caption request. `finalHost` names the host that answered. A redirect to another host that the browser blocks appears as `error` instead.
- `captions.tokenReuse.otherTrack.usable` is `true` when the player's token also read a different caption track. `sameTrack` is the control: the same transplant onto the track the player requested.
- `captions.playerApi` lists which caption-related player methods exist. The probe checks for them and calls none.
- `captions.playerRequest.captionsOnMs` is how long captions stayed on during the toggle, and `captionsHidden` is `true` when the probe hid the overlay for that time.
- `heatmapDom.paths` counts the SVG paths of the "most replayed" graph found in the player. `samplePath` holds the start of the first one.
- `heatmap.heatKeysSeen` lists key names containing "heat" in the page data. Zero markers with an empty list means the video has no heatmap. Zero markers with names listed means the probe's parser needs updating.
- `captions.playerRequest.wordLevelTiming` is `true` when cues carry per-word offsets, which allows tighter skip boundaries.
- `captions.getTranscript.status` and `errorStatus` hold whatever the transcript endpoint returned. A refusal there most likely means the endpoint wants a signed request.
- `heatmap.markers` holds `[startMs, durationMs, intensity]` triples.

- `toggleTests` lists the toggle tests run on the video. `captionTextPresent` is `true` when a caption line existed during the test.
- `transcript.cues` holds `[startMs, durationMs, text]` for every cue. It is present only in a **Download + transcript** file.

Caption URL values are never written to a report. Only the parameter names are, because the values include signatures and session tokens.

## Test the probe

`test/smoke.js` runs `probe.js` in Node against a mocked YouTube page. It needs no packages. From the root of your clone, run:

```
node probe/test/smoke.js
```

The test covers a normal page and a page with stale data. It checks the probe's logic only. It can't tell you what live YouTube returns.
