# End-to-end checks

These scripts load the built extension into a browser and drive it against a mock YouTube watch page. Every request is mocked: the watch page, the caption endpoint, SponsorBlock, the Anthropic API, and the OpenAI API. Nothing reaches the real sites, and no real API key is used.

They run in Chromium (`dist/chromium`, through Playwright) and in Firefox (`dist/firefox`, as a temporary add-on through geckodriver). They are not part of `npm test` or `npm run check`. Run them in both browsers before handing over a change to capture, skipping, detection, storage, or the settings page.

| Script | What it checks |
| --- | --- |
| `detect.mjs` | Detection with a key: no key sends nothing; a past live stream's recording is analyzed and its sponsor skipped with the "(detected)" toast; captions are switched back; a tokenless caption request from another script on the page (as the step 1 probe makes) does not hide the player's; content scripts can't read local storage (Chromium only; Firefox has no such control, so the check is skipped); the second visit is cached; a stream that is live now is not analyzed; the settings page shows the last detection and **Clear detection cache** works; an OpenAI model with an OpenAI key is served by OpenAI, not Anthropic. |
| `sponsorblock.mjs` | With no key: a SponsorBlock sponsor is skipped and labeled as SponsorBlock's; a creator chapter titled "Sponsor" is skipped and labeled "(chapter)" while a YouTube auto-chapter is not; a channel excluded by handle on the settings page gets no lookup; the settings page shows a key row per provider. |

| File | Role |
| --- | --- |
| `harness.mjs` | Picks the browser and gives the scripts one interface: open a watch page, read its `[Skipjack]` console lines, open the settings page, read and write extension storage. |
| `mock.mjs` | The mock watch page and API answers, shared by both browsers. |
| `browser-chromium.mjs` | Playwright's Chromium with the unpacked extension; Playwright's request routing serves the mock. |
| `browser-firefox.mjs` | Firefox through geckodriver, driven with plain WebDriver requests plus a BiDi WebSocket for console messages (no client library); a local proxy terminates HTTPS with a throwaway certificate and serves the mock. |
| `test.webm` | A 2-minute blank video, so seeking works. |

## Chromium

You need Playwright and its Chromium build. Playwright is not a dependency of Skipjack, so install it without saving:

```
npm install --no-save playwright@1.56.0
npx playwright install chromium
```

Then, from the repository root:

```
npm run e2e
```

That builds the extension, then runs both scripts. Each prints one `PASS` or `FAIL` line per check and exits with an error if any check fails.

To use a Playwright installed elsewhere, set `PLAYWRIGHT` to its package name or to the path of its `index.mjs`.

## Firefox

You need Firefox 140 or later, geckodriver 0.36 or later, and `openssl` (on Windows, Git for Windows ships one, and the scripts look there). Firefox 158 and geckodriver 0.37.1 are what the checks were written against.

The scripts look for `firefox` and `geckodriver` in `~/.cache/skipjack-e2e` (`firefox/firefox` and `geckodriver`), in the repository's git-ignored `.cache` folder (same layout), in the usual install locations, and last on `PATH`, because a `firefox` on `PATH` is sometimes a launcher or shim rather than the browser. Each run prints which it picked. `FIREFOX`, `GECKODRIVER`, and `OPENSSL` override the search.

On Linux, to put both in `~/.cache/skipjack-e2e`:

```
mkdir -p ~/.cache/skipjack-e2e && cd ~/.cache/skipjack-e2e
curl -sSLO https://ftp.mozilla.org/pub/firefox/releases/158.0.1/linux-x86_64/en-US/firefox-158.0.1.tar.xz
tar xJf firefox-158.0.1.tar.xz
curl -sSL https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux64.tar.gz | tar xz
```

On Windows, with Firefox installed in the usual place, download `geckodriver-v0.37.1-win64.zip` from the same releases page and put `geckodriver.exe` in `%USERPROFILE%\.cache\skipjack-e2e` or in the repository's `.cache` folder.

Then, from the repository root:

```
npm run e2e:firefox
```

## Watching the browser

Set `HEADED=1` to see the browser. In PowerShell:

```
$env:HEADED = '1'; npm run e2e; Remove-Item Env:HEADED
```

## Notes

- Chromium: the scripts use Playwright's own Chromium (`channel: 'chromium'`). Branded Chrome and Edge no longer load unpacked extensions from the command line.
- Firefox: Firefox has no request routing an extension's own requests pass through, so the session is given a local HTTP proxy, and the proxy answers every `CONNECT` tunnel itself with a self-signed certificate (made by `openssl` at each run, valid for two days). The session accepts any certificate, and certificate pinning is turned off because YouTube's hosts are pinned to real roots.
- Firefox: Marionette refuses to navigate a tab to a `moz-extension://` page, so the settings page is opened from Marionette's chrome context, which is why geckodriver runs with `--allow-system-access`. The same route finds the add-on's internal URL, so no fixed UUID is needed.
- Firefox: the extension's console lines arrive over a WebDriver BiDi connection (`log.entryAdded`), each tagged with the tab it came from. Firefox writes nothing to stdout on Windows, so this is the route that works on every OS.
- Firefox grants `host_permissions` at install here (`extensions.originControls.grantByDefault`), so the content script runs on the mock page without a toolbar prompt.
- The mock video is served with byte-range support. Without it the video is not seekable, and every skip snaps back to the start.
- Video IDs in the scripts are made up. Don't put a real video ID here: reports that name videos you watched stay in `probe/reports`, which git ignores.
