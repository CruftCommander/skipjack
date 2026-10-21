# Detection eval

The eval runs Skipjack's transcript detection on probe reports that have hand-verified boundaries, and scores each model against them. Its results choose the default model: the cheapest model that matches the verified boundaries.

The eval sends the same prompt the extension sends, through the same Anthropic provider (`src/llm/anthropic.ts`), so a prompt change can be measured before it ships.

## What it needs

- Probe reports saved with **Download + transcript** in `probe/reports`. The file names end in `-transcript.json`.
- `probe/reports/ground-truth.json`, mapping each video ID to its verified segments. Times are in seconds. An empty list means the video has nothing to skip.

  ```json
  {
    "wIe3eDfGKUo": [{ "category": "sponsor", "start": 226, "end": 314 }],
    "F1Yct6HDkYU": []
  }
  ```

- An Anthropic API key in the `ANTHROPIC_API_KEY` environment variable.

Both files stay out of Git, because `probe/reports` is ignored: each report names a video you watched.

## Run it

In PowerShell, read the key without echoing it, run the eval, and then clear the key:

```powershell
Set-Location D:\GitHub\SkipJack
$secure = Read-Host -AsSecureString 'Anthropic API key'
$env:ANTHROPIC_API_KEY = [System.Net.NetworkCredential]::new('', $secure).Password
npm run eval
Remove-Item Env:ANTHROPIC_API_KEY
```

By default the eval runs `claude-haiku-5-5` and `claude-sonnet-5-5` over every report that has ground truth. To narrow it:

```powershell
npm run eval -- --models claude-haiku-5-5 --video wIe3eDfGKUo
```

## Read the results

Each verified segment prints one line with both boundaries:

- **pitch +Ns**: the boundary shows N seconds of the pitch. The start is late or the end is early.
- **content -Ns**: the boundary skips N seconds of real content. The start is early or the end is late.
- A boundary is **ok** when it shows at most 1 second of pitch and skips at most 3 seconds of content. That matches what has been accepted so far: one end 2 seconds long and one 1 second short.

`MISSED` is a verified segment with no matching detection. `EXTRA` is a detection with no verified segment, which would skip real content. The summary adds up both per model, with tokens and an estimated cost from the published prices.

The full output, including every detection's first and last words, is saved to `probe/reports/eval/`.

The scores are raw model output after `refine()`. They do not include the extension's skip margins, which add 0.5 seconds on each side by default.
