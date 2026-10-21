# Skipjack

This file overrides the fleet-wide `D:\GitHub\CLAUDE.md` for this repository.

- **Personal project, not AFS work.** Do not apply AFS stack standards. Do not sync anything to Trello, the Weekly Action Items page, or any AFS tracker. The project's tracking page is the private Notion page "Skipjack".
- **Stack:** TypeScript, esbuild, Manifest V3. Unit tests use Node's built-in test runner (`npm test`). No test framework, no UI framework.
- **Architecture rule:** nothing in `src/core` knows about YouTube or about one browser. Platform code goes in `src/platforms`, segment sources in `src/sources`, LLM providers in `src/llm`, and browser API calls in `src/browser`.
- **Before handing over a change,** run `npm run check` (type check, tests, build).
- **Git:** Jeff commits and pushes himself, from Windows. Don't commit or push for him. From a Linux shell on his machine, set `GIT_OPTIONAL_LOCKS=0`.
- **`probe/`** is the step 1 spike. Keep it as a reference; don't build on it. Its reports in `probe/reports` are git-ignored because each names a video Jeff watched.
- **Decisions already made** are on the Notion page under "Decided". Don't relitigate them.
