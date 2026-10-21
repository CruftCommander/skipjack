# Skipjack

*Skip the pitch.*

Skipjack is a browser extension that skips the sponsor reads, interaction reminders, and self-promotion that creators record into their own videos. It works on YouTube in Microsoft Edge and Chrome, with Firefox support built but untested.

Skipjack is in early development. Today it skips segments that the [SponsorBlock](https://sponsor.ajay.app) community has already marked. Automatic detection from the video's transcript, for videos nobody has marked, comes next.

## Status

| Step | What it delivers | State |
| --- | --- | --- |
| 1. Signal probe | A throwaway extension in [`probe/`](probe/README.md) that measured which signals YouTube exposes | Done |
| 2. Skeleton | The extension: SponsorBlock lookup, skipping, the skip toast with Undo, and settings | In progress |
| 3. Detection | Transcript analysis with your own LLM provider and key, starting with Anthropic | Not started |
| 4. Packaging | Store-ready packages for Chromium and Firefox from one release workflow | Not started |

## What it skips

You choose the categories on the settings page. All three are on by default.

| Category | Examples |
| --- | --- |
| Sponsor | "This video is sponsored by…" |
| Interaction reminder | Requests to like, subscribe, comment, or turn on notifications |
| Self-promotion | Merch, memberships, Patreon, and the creator's other channels |

Skipjack is built to skip a little extra rather than show any part of a pitch. By default it starts each skip half a second early and resumes half a second late. You can change both on the settings page, under **Advanced**.

Other behavior you can change on the settings page:

- **Short segments.** Interaction reminders and self-promotion shorter than 5 seconds are left alone. Sponsor reads are skipped at any length.
- **Near the end of a video.** Skipping a segment that runs to the end jumps to the end screen, which can start the next video. By default, when a skip would land within 5 seconds of the end, Skipjack lets the segment play. You can choose to skip anyway, or to skip and pause. A sponsor read is never left to play: with the default setting, it is skipped and the video pauses.
- **Channels.** You can turn skipping off for a channel. Select the Skipjack button in the toolbar while one of its videos is open, and clear **Skip segments on this channel**. You can also add a channel by URL, @handle, or channel ID on the settings page, under **Channels**. Skipjack doesn't look up videos from an excluded channel at all. The list syncs with your browser profile and holds up to 100 channels.
- **Skip message.** After each skip, a message with an **Undo** button appears in the player for 6 seconds. Undo returns to the start of the segment and lets it play.

Skipjack never skips while YouTube is playing one of its own ads, and it leaves YouTube Shorts alone.

## Build and load the extension

You need [Node.js](https://nodejs.org) 20 or later.

1. From the root of your clone, install the build tools and build:

   ```
   npm ci
   npm run build
   ```

   The build writes `dist/chromium` for Edge and Chrome, and `dist/firefox` for Firefox.

1. In Edge, open `edge://extensions`. In Chrome, open `chrome://extensions`.
1. Turn on **Developer mode**.
1. Select **Load unpacked**, and then choose the `dist/chromium` folder.
1. Open a YouTube video that SponsorBlock users have marked.

To open settings, select the Skipjack button in the toolbar, and then select **Settings**. If the button is hidden, open it from the extensions menu.

After you rebuild, select the reload icon on Skipjack's card on the extensions page, and then reload the YouTube tab.

To try the Firefox build, open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `dist/firefox/manifest.json`. Firefox treats host permissions as optional. If the console shows that segment lookups fail, grant Skipjack access to `sponsor.ajay.app` from the extensions menu.

### See what Skipjack is doing

Open DevTools on the YouTube tab and filter the console to `[Skipjack]`. Each video logs how many segments were found and how many will be skipped with your settings, and each skip logs its start and end.

## Develop

| Command | What it does |
| --- | --- |
| `npm run build` | Builds every browser target into `dist/` |
| `npm run watch` | Rebuilds the scripts on every change. Run a full build after changing HTML, CSS, or the manifest. |
| `npm run typecheck` | Type-checks the code without building |
| `npm test` | Runs the unit tests with Node's built-in test runner |
| `npm run check` | Runs the type check, the tests, and the build, in that order |
| `npm run eval` | Scores transcript detection against hand-verified boundaries. Needs an Anthropic API key. See [`eval/README.md`](eval/README.md). |

### Layout

Nothing that knows about YouTube, and nothing that knows about one browser, lives in `src/core`. Each of the four plug-in points is a folder:

| Folder | Plug-in point | Adding a new one |
| --- | --- | --- |
| `src/platforms` | Platform adapters: finding the video, its ID, ads, and navigation for one media site | One new adapter, registered in `registry.ts` |
| `src/sources` | Segment sources: SponsorBlock today, the transcript detector in step 3 | One new source, passed to `SegmentService` in `src/background/index.ts` |
| `src/llm` | LLM providers for detection. Anthropic is the first. | One new provider |
| `src/browser` | The browser shell: storage, messaging, and extension UI calls | One new shell, if a browser ever stops matching the WebExtensions API |

The rest:

- `src/core` holds the segment model, settings, the skip policy (`policy.ts`, pure functions), and the controller that drives one media element (`skipper.ts`).
- `src/background` looks up segments for content scripts. Requests to SponsorBlock happen there, under the extension's host permission.
- `src/content` follows the video the user opens and runs one session per video.
- `src/detect` holds the detection prompt and the clean-up of model output, shared by every LLM provider.
- `src/ui` holds the skip toast. `src/options` holds the settings page, and `src/popup` the toolbar popup.
- `eval` scores detection against hand-verified boundaries. It is a development tool and is not part of the extension.
- `scripts/build.mjs` generates each target's manifest and bundles the scripts.

## Privacy

Skipjack sends one kind of request: a segment lookup to SponsorBlock. The request carries the first 4 characters of the SHA-256 hash of the video ID, not the ID itself, so SponsorBlock cannot tell which video you are watching. Your settings are stored in your browser's synced extension storage. Skipjack keeps no history.

## Attribution

Segment data comes from [SponsorBlock](https://sponsor.ajay.app) and its contributors. SponsorBlock's database and API are licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Skipjack is not affiliated with SponsorBlock.

## License

Skipjack is free software, licensed under the [GNU General Public License v3.0](LICENSE).
