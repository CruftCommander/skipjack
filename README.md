# Skipjack

*Skip the pitch.*

Skipjack is a browser extension that skips the sponsor reads, interaction reminders, and self-promotion that creators record into their own videos. It works on YouTube in Microsoft Edge and Chrome, with Firefox support built but untested.

Skipjack is in early development. It skips segments that the [SponsorBlock](https://sponsor.ajay.app) community has already marked, and, with your own Anthropic or OpenAI API key, finds the ones nobody has marked by reading the video's captions.

## Status

| Step | What it delivers | State |
| --- | --- | --- |
| 1. Signal probe | A throwaway extension in [`probe/`](probe/README.md) that measured which signals YouTube exposes | Done |
| 2. Skeleton | The extension: SponsorBlock lookup, skipping, the skip toast with Undo, and settings | Done |
| 3. Detection | Transcript analysis with your own LLM provider and key, starting with Anthropic | Done |
| 4. Packaging | Store-ready packages for Chromium and Firefox from one release workflow | In progress |
| 5. More providers | OpenAI as a second LLM provider, with one key per provider | In progress |

## What it skips

You choose the categories on the settings page. All three are on by default.

| Category | Examples |
| --- | --- |
| Sponsor | "This video is sponsored by…" |
| Interaction reminder | Requests to like, subscribe, or turn on notifications. A request for comments on its own, such as "let me know your thoughts in the comments", is left to play. |
| Self-promotion | Merch, memberships, Patreon, and the creator's other channels |

Skipjack finds segments in three places, and the earlier one wins for each category:

1. Segments the SponsorBlock community has marked.
1. A chapter the creator titled as a sponsor read, such as "Sponsor", "Sponsored by…", or "Ad break". It runs to the next chapter, up to 10 minutes. Chapters YouTube generates itself don't count. This needs no API key.
1. With your API key, detection from the video's captions.

The skip message says "(chapter)" or "(detected)" for the last two.

Skipjack is built to skip a little extra rather than show any part of a pitch. By default it starts each skip half a second early and resumes half a second late. You can change both on the settings page, under **Advanced**.

Other behavior you can change on the settings page:

- **Short segments.** Interaction reminders and self-promotion shorter than 5 seconds are left alone. Sponsor reads are skipped at any length.
- **Near the end of a video.** Skipping a segment that runs to the end jumps to the end screen, which can start the next video. By default, when a skip would land within 5 seconds of the end, Skipjack lets the segment play. You can choose to skip anyway, or to skip and pause. A sponsor read is never left to play: with the default setting, it is skipped and the video pauses.
- **Channels.** You can turn skipping off for a channel. Select the Skipjack button in the toolbar while one of its videos is open, and clear **Skip segments on this channel**. You can also add a channel by URL, @handle, or channel ID on the settings page, under **Channels**. Skipjack doesn't look up videos from an excluded channel at all. The list syncs with your browser profile and holds up to 250 channels.
- **Detection.** Add an Anthropic or OpenAI API key on the settings page, under **Detection**, pick one of that provider's models, and Skipjack reads each video's captions and asks the model where the pitches are. By default it runs on every video and fills in only the categories SponsorBlock has no segments for; SponsorBlock's segments win wherever they exist. Results are kept on this computer for 60 days, for up to 2,000 videos, so a video you watch again isn't paid for again; after that, or once older results are dropped to make room, it is analyzed again. If analysis fails after the provider accepted the request, the video isn't tried again with that model for a day, and Skipjack analyzes at most 60 new videos an hour. **Clear detection cache**, under **Detection**, removes every saved result. On Claude Sonnet 5.5, the default, or GPT-6.1 Sol, a 20-minute video costs about 2 cents; on Claude Haiku 5.5 or GPT-6 Luna, a fraction of a cent. To read the captions, Skipjack switches them on for a moment with the captions hidden from view, then switches them back; you can turn that off, and detection then runs only on videos you watch with captions on.
- **Undo shortcut.** Alt+Shift+U undoes the last skip, whether or not the skip message is showing. To change it in Edge, open `edge://extensions/shortcuts`; in Chrome, `chrome://extensions/shortcuts`. In Firefox, open `about:addons`, select the gear button, and then select **Manage Extension Shortcuts**.
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
| `npm run eval` | Scores transcript detection against hand-verified boundaries. Needs an API key for each provider whose models it runs. See [`eval/README.md`](eval/README.md). |
| `npm run icons` | Renders `src/icons/icon.svg` to the PNGs the manifests use. Run it after changing the SVG. Needs Playwright (`npm install --no-save playwright@1.56.0` and `npx playwright install chromium`). |
| `npm run e2e` | Builds, then checks the extension end to end against a mock YouTube page in the first Chromium browser it finds: Edge, Chrome, or Playwright's Chromium. No library needed. See [`test/e2e/README.md`](test/e2e/README.md). |
| `npm run e2e:edge`, `npm run e2e:chrome` | The same checks in that browser specifically. |
| `npm run e2e:firefox` | The same checks in Firefox, as a temporary add-on. Needs Firefox and geckodriver. |

### Release

The [release workflow](.github/workflows/release.yml) builds the Chromium and Firefox packages and attaches them to a draft GitHub release.

1. Set `version` in `package.json`. The manifests take the version from there. Use up to four dot-separated numbers, such as `0.2.0`. Browsers don't accept versions such as `0.2.0-beta.1`.
1. Run `npm run check`, and then commit the change.
1. Tag the commit with the version and push both:

   ```
   git tag v0.2.0
   git push origin main v0.2.0
   ```

1. Wait for the **Release** workflow to finish. It fails if the tag doesn't match `package.json`.
1. On GitHub, open the draft release, check the notes and the packages, and then publish it.

Each release carries `skipjack-<version>-chromium.zip` for Edge and Chrome, `skipjack-<version>-firefox.zip` for Firefox, and `SHA256SUMS.txt`. Every run checks the Firefox build with Mozilla's `web-ext lint`.

A tagged release also carries `skipjack-<version>-firefox.xpi`, signed by addons.mozilla.org as an unlisted add-on, which installs permanently in Firefox. Signing needs an API key from [addons.mozilla.org](https://addons.mozilla.org/developers/addon/api/key/), stored as two repository secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Without them the release is made without the `.xpi`. Mozilla signs each version only once, so a version that failed after signing needs a new version number. To build the packages without a release, run the workflow from the **Actions** tab. The packages are attached to that run as an artifact.

### Layout

Nothing that knows about YouTube, and nothing that knows about one browser, lives in `src/core`. Each of the four plug-in points is a folder:

| Folder | Plug-in point | Adding a new one |
| --- | --- | --- |
| `src/platforms` | Platform adapters: finding the video, its ID, ads, and navigation for one media site | One new adapter, registered in `registry.ts` |
| `src/sources` | Segment sources: SponsorBlock today, the transcript detector in step 3 | One new source, passed to `SegmentService` in `src/background/index.ts` |
| `src/llm` | LLM providers for detection: Anthropic (Messages API) and OpenAI (Responses API), sharing one prompt and one streaming reader. | One new provider, plus its host permission in `scripts/build.mjs` |
| `src/browser` | The browser shell: storage, messaging, and extension UI calls | One new shell, if a browser ever stops matching the WebExtensions API |

The rest:

- `src/core` holds the segment model, settings, the skip policy (`policy.ts`, pure functions), and the controller that drives one media element (`skipper.ts`).
- `src/background` looks up segments for content scripts. Requests to SponsorBlock happen there, under the extension's host permission.
- `src/content` follows the video the user opens and runs one session per video.
- `src/detect` holds the detection prompt and the clean-up of model output, shared by every LLM provider.
- `src/ui` holds the skip toast. `src/options` holds the settings page, and `src/popup` the toolbar popup.
- `eval` scores detection against hand-verified boundaries. It is a development tool and is not part of the extension.
- `test/e2e` drives the built extension in Edge, Chrome, or Chromium, and in Firefox, against a mock YouTube page. Like `eval`, it is a development tool.
- `scripts/build.mjs` generates each target's manifest and bundles the scripts.

## Privacy

Skipjack has no server of its own. It sends two kinds of request:

- **A segment lookup to SponsorBlock.** The request carries the first 4 characters of the SHA-256 hash of the video ID, not the ID itself, so SponsorBlock cannot tell which video you are watching.
- **Detection requests to your LLM provider, only if you add an API key.** For each video analyzed, Skipjack sends the video's captions, title, chapter titles, whether it is marked as paid promotion, and any description lines that look promotional, to the provider of the model you picked (Anthropic or OpenAI), using your key for it. That provider's terms for your account apply to that data. Requests to OpenAI ask it not to store the response.

When you install Skipjack in Firefox, Firefox lists website content as data it collects. That refers to the captions sent to your LLM provider for detection, which happens only after you add a key.

Your settings and excluded channels are stored in your browser's synced extension storage. Your API keys and the detection results stay in local extension storage on this computer and never sync. Web pages can't read local extension storage. In Edge and Chrome, Skipjack also hides it from its own scripts that run on YouTube, so only its settings page and background script can read your keys. Firefox has no way to do that, so there Skipjack's script on YouTube pages could read it if the page's renderer were compromised.

Skipjack does keep a record of the videos it analyzes, on this computer only. Each saved detection result is stored under the video's ID for up to 60 days, and the settings page shows the most recent one. To delete them, select **Clear detection cache** on the settings page, under **Detection**. Removing Skipjack deletes them too.

## Attribution

Uses SponsorBlock data licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) from <https://sponsor.ajay.app/>. The segments come from SponsorBlock's contributors. Skipjack is not affiliated with SponsorBlock.

## License

Skipjack is free software, licensed under the [GNU General Public License v3.0](LICENSE).
