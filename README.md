# Alfred

Alfred is a local, cmux-backed personal assistant that can observe, coordinate, and safely command Pi, Codex, shells, and other terminal agents or processes running inside cmux.

This project is intentionally separate from `pi-smart-voice-notify`. The current Pi extension remains the live/default `/alfred` implementation while Alfred is built in parallel, but the long-term goal is for Alfred to own its runtime and use Pi as one target/interface rather than living inside Pi.

## Plan

See:

```text
docs/plans/alfred/PLAN.md
```

## Initial Goal

Build a local runtime/daemon that uses cmux as the workspace/surface substrate, then expose it through `/alfred` in Pi, CLI, web UI, and eventually non-Pi voice/input surfaces.

## Development

The current Pi extension remains the live/default `/alfred` path while this repo is built in parallel.

```bash
pnpm install
pnpm run check
pnpm run typecheck
pnpm test
```

Start the local daemon:

```bash
ALFRED_LOCAL_TOKEN=dev-local-token npm run daemon
```

Start Alfred 2 with a voice listener:

```bash
# Current/default path: Wispr Flow transcript listener
ALFRED2_LISTENER=wispr pnpm run alfred2

# No always-on listener; dashboard and /ask still work
ALFRED2_LISTENER=off pnpm run alfred2

# Native wake-listener mode. The wake command owns local mic/wake-word detection
# and prints either `WAKE`, `COMMAND: do something`, or JSON lines like
# {"type":"command","text":"do something"}. If it prints WAKE, Alfred then
# runs ALFRED2_NATIVE_TRANSCRIBE_COMMAND and sends that transcript to /ask.
ALFRED2_LISTENER=native \
  ALFRED2_NATIVE_WAKE_COMMAND="/path/to/local-wake-helper" \
  ALFRED2_NATIVE_TRANSCRIBE_COMMAND="/path/to/record-and-transcribe-once" \
  pnpm run alfred2
```

Native listener privacy boundary: passive wake detection should happen locally in the helper, passive audio should not be saved, and Alfred only sends the post-wake command transcript to `/ask`. On macOS, any helper that keeps the microphone open for wake detection should trigger the system mic indicator while it is running.

By default Alfred binds `127.0.0.1:47321` and serves the built React dashboard at:

```text
http://127.0.0.1:47321/dashboard
```

`pnpm run alfred2` builds `web/` before starting. For frontend development, run Alfred in one terminal and Vite in another:

```bash
ALFRED2_LISTENER=off node --experimental-strip-types src/alfred-2/cli.ts
pnpm run web:dev
```

Vite runs at `http://127.0.0.1:5173/dashboard/` and proxies the existing Alfred APIs to port `47321`.

### Alfred 2 memory boundaries

- **Profile** facts are durable in `~/.alfred/profile.json`, carry stable IDs and write-time provenance, and are managed from the Memory page or the compatible `remember`/`recall` tools.
- **Session** taxonomy records are sanitized, bounded, and process-scoped. Alfred's separate durable activity history may retain bounded request/response and tool metadata.
- **Knowledge** currently defines source metadata and its Memory tab only; ingestion and retrieval are deferred to Phase 5.

Profile and history files are stored with owner-only permissions. Dashboard profile writes use `POST /dashboard/facts`; stable-ID deletion uses `DELETE /dashboard/facts/:id`. `/dashboard/state` exposes canonical grouped memory state while retaining the legacy `profileFacts` and `memoryTurns` fields during migration.

Alfred 2 speed knobs:

- `ALFRED_SPEECH_FORMATTER_ENABLED=auto` — only runs the optional speech-polishing LLM pass for screen-like/markup-heavy responses. Use `1`/`true` to always polish or `0`/`false` to never polish.
- `ALFRED_SILENT=1` or `ALFRED_SILENT_TESTS=1` — disables TTS playback. `pnpm test` sets test silence automatically, and Node's test runner is auto-detected.
- `ALFRED_CONTEXT_CACHE_MS=120000` — keeps full cmux/git context warm for two minutes.
- `ALFRED_CONTEXT_WORKSPACE_LIMIT=5` — inspects only the most recent/relevant workspaces per full-context request.
- `ALFRED_PR_WATCHER=1` — poll GitHub unread notifications for PRs authored by you, notify via Alfred, and append simple entries to `~/.alfred/pr-watch-memory.md`.
- `ALFRED_PR_WATCH_INTERVAL_MS=120000` — PR watcher poll interval; minimum 30000 ms.

Daemon env config:

- `ALFRED_HOST` — loopback bind host (`127.0.0.1`, `localhost`, or `::1`), default `127.0.0.1`.
- `ALFRED_PORT` — bind port, default `47321`.
- `ALFRED_LOCAL_TOKEN` — local auth token for authenticated API calls.

If `ALFRED_LOCAL_TOKEN` is not set, the daemon generates a process-local token, prints it once for the local operator after startup succeeds, and does not persist it. The dashboard URL intentionally does not include tokens; enter the token manually in the dashboard.

Smoke commands:

```bash
curl -s http://127.0.0.1:47321/health
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/state
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/surfaces
```

Google Gmail/Calendar/Docs setup:

```bash
# Put your OAuth Desktop App JSON here first:
# ~/.alfred/google/oauth-client.json
pnpm run google:auth
```

The Google integration is read-only by default and uses `GOOGLE_OAUTH_CLIENT_PATH`, `GOOGLE_OAUTH_TOKEN_PATH`, and `GOOGLE_SCOPES` from `~/.alfred/daemon.env` when present. Enable Gmail, Calendar, Docs, and Drive APIs in the same Google Cloud project before authorizing.

Initial source layout:

```text
src/contracts/   Shared request/response/action/event contracts
src/core/        Alfred core runtime placeholder
src/cmux/        cmux world-model adapter placeholder
src/daemon/      daemon/server placeholder
src/cli/         CLI source placeholder
web/             React/Vite Alfred 2 dashboard
src/testing/     contract fixtures and test helpers
```
