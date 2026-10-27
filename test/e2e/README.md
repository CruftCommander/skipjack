# End-to-end checks

These scripts load the built extension into a real browser and drive it against a mock YouTube watch page. Every request is mocked: the watch page, the caption endpoint, SponsorBlock, the Anthropic API, and the OpenAI API. Nothing reaches the real sites, and no real API key is used.

They run in Edge, Chrome, or a plain Chromium build (`dist/chromium`, over the Chrome DevTools Protocol) and in Firefox (`dist/firefox`, as a temporary add-on through geckodriver). No automation library is needed. They are not part of `npm test` or `npm run check`. Run them in Edge and Firefox before handing over a change to capture, skipping, detection, storage, or the settings page.

| Script | What it checks |
| --- | --- |
| `detect.mjs` | Detection with a key: no key sends nothing; a past live stream's recording is analyzed and its sponsor skipped with the "(detected)" toast; captions are switched back; a tokenless caption request from another script on the page (as the step 1 probe makes) does not hide the player's; content scripts can't read local storage (Chromium browsers only; Firefox has no such control, so the check is skipped); the second visit is cached; a stream that is live now is not analyzed; the settings page shows the last detection and **Clear detection cache** works; an OpenAI model with an OpenAI key is served by OpenAI, not Anthropic. |
| `sponsorblock.mjs` | With no key: a SponsorBlock sponsor is skipped and labeled as SponsorBlock's; a creator chapter titled "Sponsor" is skipped and labeled "(chapter)" while a YouTube auto-chapter is not; the diagnostic log records nothing while off, records the page's lines once turned on from the settings page, downloads as a dated text file, clears, and stops recording when turned off; a channel excluded by handle on the settings page gets no lookup; the settings page shows a key row per provider. |

| File | Role |
| --- | --- |
| `harness.mjs` | Picks the browser and gives the scripts one interface: open a watch page, read its `[Skipjack]` console lines, open the settings page, read and write extension storage. |
| `mock.mjs` | The mock watch page and API answers. |
| `proxy.mjs` | A local HTTP proxy that terminates every HTTPS tunnel itself with a throwaway certificate (made by `openssl` at each run) and answers from the mock. Both browsers are pointed at it. |
| `browser-chromium.mjs` | Edge, Chrome, or Chromium over CDP through the browser's debugging pipe: the extension is loaded with `Extensions.loadUnpacked`, pages are driven with `Target`, `Page`, and `Runtime`. |
| `browser-firefox.mjs` | Firefox through geckodriver, driven with plain WebDriver requests plus a BiDi WebSocket for console messages. |
| `test.webm` | A 2-minute blank video, so seeking works. |

## What you need

- `openssl`, for the proxy's certificate. On Windows, Git for Windows ships one and the scripts look there (`C:\Program Files\Git\usr\bin` or `mingw64\bin`); `OPENSSL` overrides.
- For the Chromium side: Edge or Chrome 137 or later, or Playwright's Chromium. The scripts look in the usual install places, then on `PATH`, then in Playwright's browser cache and the repository's git-ignored `.cache\chromium`. `EDGE`, `CHROME`, and `CHROMIUM` override.
- For Firefox: Firefox 140 or later and geckodriver 0.36 or later (written against Firefox 158 and geckodriver 0.37.1). The scripts look in `~/.cache/skipjack-e2e` (`firefox/firefox` and `geckodriver`), in the repository's git-ignored `.cache` folder (same layout), in the usual install locations, and last on `PATH`, because a `firefox` on `PATH` is sometimes a launcher rather than the browser. `FIREFOX` and `GECKODRIVER` override.

Each run prints which binaries it picked.

On Linux, to put Firefox and geckodriver in `~/.cache/skipjack-e2e`:

```
mkdir -p ~/.cache/skipjack-e2e && cd ~/.cache/skipjack-e2e
curl -sSLO https://ftp.mozilla.org/pub/firefox/releases/158.0.1/linux-x86_64/en-US/firefox-158.0.1.tar.xz
tar xJf firefox-158.0.1.tar.xz
curl -sSL https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux64.tar.gz | tar xz
```

On Windows, with Firefox installed in the usual place, download `geckodriver-v0.37.1-win64.zip` from the same releases page and put `geckodriver.exe` in `%USERPROFILE%\.cache\skipjack-e2e` or in the repository's `.cache` folder.

## Run them

From the repository root:

```
npm run e2e            # the first Chromium browser found: Edge, then Chrome, then Playwright's Chromium
npm run e2e:edge
npm run e2e:chrome
npm run e2e:firefox
```

Each builds the extension, then runs both scripts. Each script prints one `PASS`, `FAIL`, or `SKIP` line per check and exits with an error if any check fails.

To watch the browser, set `HEADED=1`. In PowerShell:

```
$env:HEADED = '1'; npm run e2e:edge; Remove-Item Env:HEADED
```

## Notes

- Chromium browsers: Edge and Chrome removed `--load-extension` from their branded builds in version 137. The replacement is the CDP command `Extensions.loadUnpacked`, which the browser accepts only when started with `--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`; that is why the back end talks CDP over the pipe (file descriptors 3 and 4, NUL-separated JSON) rather than a debugging port. `--ignore-certificate-errors` accepts the proxy's certificate, including for YouTube's pinned hosts.
- Chromium browsers: the extension's own URL scheme is read from its service worker target, so Edge's `extension://` and Chrome's `chrome-extension://` both work without special cases.
- Firefox: Marionette refuses to navigate a tab to a `moz-extension://` page, so the settings page is opened from Marionette's chrome context, which is why geckodriver runs with `--allow-system-access`. The same route finds the add-on's internal URL, so no fixed UUID is needed.
- Firefox: the extension's console lines arrive over a WebDriver BiDi connection (`log.entryAdded`), each tagged with the tab it came from. Firefox writes nothing to stdout on Windows, so this is the route that works on every OS.
- Firefox grants `host_permissions` at install here (`extensions.originControls.grantByDefault`), so the content script runs on the mock page without a toolbar prompt. Certificate pinning is turned off (`security.cert_pinning.enforcement_level`) because YouTube's hosts are pinned to real roots.
- The mock video is served with byte-range support. Without it the video is not seekable, and every skip snaps back to the start.
- Video IDs in the scripts are made up. Don't put a real video ID here: reports that name videos you watched stay in `probe/reports`, which git ignores.
