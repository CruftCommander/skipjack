# End-to-end checks

These scripts load the built extension from `dist/chromium` into Chromium and drive it against a mock YouTube watch page. Every request is mocked: the watch page, the caption endpoint, SponsorBlock, and the Anthropic API. Nothing reaches the real sites, and no real API key is used.

They are not part of `npm test` or `npm run check`. Run them before handing over a change to capture, skipping, detection, storage, or the settings page.

| Script | What it checks |
| --- | --- |
| `detect.mjs` | Detection with a key: no key sends nothing; a past live stream's recording is analyzed and its sponsor skipped with the "(detected)" toast; captions are switched back; content scripts can't read local storage; the second visit is cached; a stream that is live now is not analyzed; the settings page shows the last detection and **Clear detection cache** works. |
| `sponsorblock.mjs` | With no key: a SponsorBlock sponsor is skipped and labeled as SponsorBlock's; a channel excluded by handle on the settings page gets no lookup. |

`harness.mjs` holds the shared mock page and routes. `test.webm` is a 2-minute blank video, so seeking works.

## Run them

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

To watch the browser, set `HEADED=1`. In PowerShell:

```
$env:HEADED = '1'; npm run e2e; Remove-Item Env:HEADED
```

To use a Playwright installed elsewhere, set `PLAYWRIGHT` to its package name or to the path of its `index.mjs`.

## Notes

- The scripts use Playwright's own Chromium (`channel: 'chromium'`). Branded Chrome and Edge no longer load unpacked extensions from the command line.
- The mock video is served with byte-range support. Without it the video is not seekable, and every skip snaps back to the start.
- Video IDs in the scripts are made up. Don't put a real video ID here: reports that name videos you watched stay in `probe/reports`, which git ignores.
