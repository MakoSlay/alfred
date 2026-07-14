# Code Context

## Files Retrieved
1. `src/alfred-2/cli.ts` (lines 1-92) - Alfred 2 process entrypoint; starts HTTP server and optional Wispr listener, reads daemon env.
2. `src/alfred-2/wispr-listener.ts` (lines 1-289) - Current non-native wake listener that tails Wispr Flow logs and queries sqlite transcripts.
3. `test/alfred2-wispr-listener.test.ts` (lines 1-29) - Existing wake-word parsing tests.
4. `package.json` (lines 1-33) - Runtime constraints: ESM, Node >=22.12, no native audio deps, tests use `node --test --experimental-strip-types`.
5. `src/alfred-2/server.ts` (lines 27-44, 292-315, 380-413, 499-818) - Server contract, dashboard state, dashboard/TTS endpoints, `/ask` ingestion and TTS response flow.
6. `src/alfred-2/speech.ts` (lines 1-220) - TTS provider/env patterns and macOS command integration style.
7. `src/alfred-2/dashboard.ts` (lines 1-220, plus inline client later in file) - Dashboard state shape and Voice Studio UI; likely place to expose listener status.

## Key Code

### Current CLI startup
`src/alfred-2/cli.ts` starts the server then, unless `ALFRED2_WISPR_LISTENER=0`, starts Wispr:
```ts
const ENABLE_WISPR_LISTENER = process.env.ALFRED2_WISPR_LISTENER !== "0";
...
wisprListener = await startWisprListener({
  alfredUrl: `http://${server.host}:${server.port}/ask`,
  dbPath: process.env.WISPR_DB_PATH,
  logPath: process.env.WISPR_LOG_PATH,
  wakeWords: process.env.ALFRED2_WAKE_WORDS?.split(",").map(...),
});
```
Shutdown calls `wisprListener?.stop()` before closing the server.

### Current Wispr listener responsibilities
`src/alfred-2/wispr-listener.ts` provides useful reusable patterns:
- `WisprListenerConfig`, `WisprListener` lifecycle interface.
- `stripWakeWord()` and `extractWakeCommand()` gate commands by wake phrase.
- posts to `/ask` with JSON `{ text, source: "wispr-flow", wispr: {...} }`.
- default wake words: `alfred`, `hey alfred`, `okay alfred`, `ok alfred`.

### Server ingestion and dashboard
`src/alfred-2/server.ts` accepts command text at `/ask`, `/`, `/handle` and speaks response via `speak()` after muted checks. Dashboard state currently includes TTS/personality/tools but no listener status. `buildDashboardState()` is the right server-side extension point.

### Package constraints
No native wake-word/audio package is present. `package.json` dependencies only include `exa-js`; dev deps are TypeScript and Node types. Any native listener will add package/install risk. Scripts run TypeScript directly with Node strip types, so source must be executable without a build step.

## Architecture
Alfred 2 is currently push-based: a listener posts recognized text to HTTP `/ask`; server handles intent, tools, notifications, and TTS. A native always-on wake-word listener should preserve that boundary: local audio/VAD/wake detection module emits finalized command text, then posts to `/ask`. Avoid coupling microphone/audio code into `server.ts`.

Recommended file structure:
1. `src/alfred-2/listeners/types.ts` - shared `WakeListener`, `WakeListenerConfig`, `WakeListenerStatus`, `WakeCommandEvent`.
2. `src/alfred-2/listeners/wispr.ts` - move or wrap existing `wispr-listener.ts` to implement shared interface.
3. `src/alfred-2/listeners/native-wake.ts` - native always-on listener implementation.
4. `src/alfred-2/listeners/index.ts` - selects provider from env and starts listener.
5. `test/alfred2-native-wake-listener.test.ts` - unit tests using mocked audio/wake/transcription dependencies; no real mic.
6. Optional: `src/alfred-2/listeners/post-to-alfred.ts` - shared POST helper so Wispr/native payload behavior stays consistent.

Recommended env vars:
- `ALFRED2_LISTENER=wispr|native|off` (preferred replacement for boolean `ALFRED2_WISPR_LISTENER`; keep old var as compat).
- `ALFRED2_WAKE_WORDS=alfred,hey alfred,ok alfred` (already used).
- `ALFRED2_NATIVE_WAKE_ENABLED=1` only if a separate feature flag is desired.
- `ALFRED2_NATIVE_WAKE_MODEL_PATH=/path/to/model` for Porcupine/OpenWakeWord/etc.
- `ALFRED2_NATIVE_WAKE_SENSITIVITY=0.5`.
- `ALFRED2_NATIVE_AUDIO_DEVICE=<name-or-id>`.
- `ALFRED2_NATIVE_TRANSCRIBE_PROVIDER=whisper|apple|none` and provider-specific model/path vars if wake detection does not include command transcription.
- `ALFRED2_LISTENER_STATUS=1` if dashboard status polling should be opt-in.

Implementation guidance:
- Severity: medium - `cli.ts` currently hard-codes Wispr terminology and default-on behavior. Add provider selection before native work, so native can be opt-in and Wispr remains stable.
- Severity: high - Native mic packages often need install/build permissions and macOS microphone consent. Keep native dependency behind optional dynamic import and fail soft with actionable logs.
- Severity: medium - `WisprListener` lacks status/error reporting. Add `getStatus()` or event callback before dashboard integration.
- Severity: medium - Dashboard is monolithic inline HTML/JS. Minimal change: add listener fields to `DashboardState` and a small status card; avoid large UI refactors.
- Severity: low - Existing wake-word parsing can be reused, but native flow may receive text without wake phrase after detector fires. Support a config mode such as `requiresWakePrefix` for transcript gating.

Validation tests to add/update:
1. Extend `test/alfred2-wispr-listener.test.ts` or new shared test to verify `stripWakeWord` still accepts punctuation and custom wake words.
2. `test/alfred2-listener-selection.test.ts`: env `ALFRED2_LISTENER=off|wispr|native`; old `ALFRED2_WISPR_LISTENER=0` disables listener.
3. `test/alfred2-native-wake-listener.test.ts`: with mocked wake engine and mocked transcriber, wake event posts exactly once to `/ask` with `{ source: "native-wake" }`.
4. Native duplicate suppression test: repeated wake events within debounce window do not double-post.
5. Native error resilience test: microphone/model init failure returns non-running status and does not crash CLI/server.
6. Dashboard state test: `/dashboard/state` includes listener provider/running/lastError without exposing secrets/model tokens.
7. Package validation: `npm run typecheck` and `npm test`; if adding native deps, add a test that skips real audio in CI.

## Start Here
Open `src/alfred-2/cli.ts` first. It is the current listener wiring point and determines env compatibility, startup behavior, and shutdown lifecycle.

## Supervisor coordination
No coordination needed. This was inspection-only; no source files were modified. Note: repository already had many pre-existing unstaged/untracked files before writing this requested context artifact.

## Residual Risks
- Native audio dependency choice is still undecided; package compatibility with Node 22/macOS must be verified.
- macOS microphone permission and background daemon launch context may block capture even if code is correct.
- Dashboard file is large and inline; status UI changes are easy to regress without browser/manual smoke test.
- Existing repo status is dirty, so future implementer should avoid mixing unrelated changes.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings cite src/alfred-2/cli.ts, wispr-listener.ts, server.ts, dashboard.ts, speech.ts, package.json, and tests with severity notes for implementation risks."
    }
  ],
  "changedFiles": [
    "context.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git status --short",
      "result": "passed",
      "summary": "Confirmed repository already had many unstaged/untracked files before writing the requested context artifact."
    }
  ],
  "validationOutput": [
    "Inspection only; no tests run."
  ],
  "residualRisks": [
    "Native audio package and macOS microphone permission behavior remain to be validated.",
    "Dirty working tree contains many pre-existing changes unrelated to this scouting task."
  ],
  "noStagedFiles": true,
  "diffSummary": "Wrote scouting findings to /Users/muhammadabdul/work/alfred/context.md only.",
  "reviewFindings": [
    "medium: src/alfred-2/cli.ts:14 - Listener is Wispr-specific and default-on; introduce provider selection before adding native listener.",
    "high: package.json:23 - No native audio/wake dependency exists; adding one risks install/build/runtime failures on Node 22/macOS.",
    "medium: src/alfred-2/wispr-listener.ts:22 - Listener lifecycle lacks status/error reporting needed for dashboard visibility.",
    "medium: src/alfred-2/dashboard.ts:1 - Dashboard is monolithic inline HTML/JS, so listener status UI should be minimal and well-tested."
  ],
  "manualNotes": "Task requested no source edits; only the authoritative context artifact was written."
}
```