# Alfred

Alfred is a local personal AI assistant. It runs as a daemon on your machine, accepts voice or text commands, and can answer questions, remember facts about you, search your notes, run tools, and watch your work in the background. A React dashboard sits on top of it.

## Current status

Alfred is a private, single-user project in active development. The standalone daemon and dashboard (the `alfred-2` runtime) are the current focus, and they run on macOS today. Retrieval is lexical; embeddings are deferred by design. There is no hosted or multi-user mode.

## How it works

Alfred runs as a single local daemon that binds to loopback and exposes an HTTP API. The daemon owns the agent and all state; voice listeners, the dashboard, and the CLI are clients that talk to it.

```text
voice listener / dashboard / CLI
              |
              v
   daemon  (HTTP, 127.0.0.1:47321)
              |
              v
        agent + tool loop
              |
              v
 tools / memory / knowledge / watchers
              |
              v
   speech (TTS) + dashboard state
```

The path for a single command:

1. A listener or the dashboard posts the command text to `/ask`.
2. The agent core interprets the request and runs its tool loop, calling tools as needed.
3. The reply is written to dashboard state and spoken through the configured TTS path.

## Capabilities

- **Agent core** — an LLM agent with a tool loop (`src/alfred-2/agent.ts`, `src/alfred-2/tool-loop.ts`).
- **Voice** — input from a Wispr Flow transcript listener or a native wake-word helper, plus speech output with an optional polishing pass (`wispr-listener.ts`, `native-wake-listener.ts`, `speech.ts`).
- **Memory** — durable profile facts with stable IDs and provenance, session-scoped working memory, reviewed extraction from conversations, and bounded activity history (`memory.ts`, `profile.ts`, `memory/`).
- **Knowledge** — local Text/Markdown import with deterministic chunking and lexical retrieval with request-scoped citations (`knowledge.ts`, `context-rag.ts`).
- **Tools** — web search and fetching, file read and write, notes, profile, knowledge search, session control, settings, and a read-only Google integration for Gmail, Calendar, Docs, and Drive (`src/alfred-2/tools/`).
- **Proactive watchers** — a work advisor, a GitHub PR notifier, and idle, meeting, and wellness awareness (`src/alfred-2/watchers/`, `proactive/`, `activity/`).
- **Terminal agents** — observes and coordinates terminal agents and processes running in cmux, such as Pi, Codex, and shells (`src/cmux/`, `process.ts`, `bash-command.ts`).
- **Goals and schedules** — durable goals and bounded scheduled reminders (`goals.ts`).
- **Safety** — a risk classifier, a confirmation guard, scoped autonomy, and undo (`risk.ts`, `confirmation.ts`, `undo.ts`).

## Design principles

- **Local-first.** The daemon binds to loopback (`127.0.0.1:47321` by default). Profile, history, knowledge, and notes live in `~/.alfred` and are written with owner-only permissions.
- **Scoped autonomy.** Routine mutations, session replies, and daemon loops each hold their own independent grant; enabling one never enables another.
- **Confirmation before action.** Anything that touches files, sends a message, or runs a command goes through a confirmation guard.
- **Privacy defaults.** Passive audio is not stored, and secrets are redacted before text reaches the model.

## Tech stack

TypeScript and Node (ESM, Node >= 22), with a React + Vite frontend. The backend runs directly through Node's type stripping, so there is no build step, and the project has no native audio dependencies.

## Prerequisites

- Node.js >= 22.12
- pnpm 11.10 (via `corepack enable`)
- An OpenAI-compatible LLM endpoint and API key (see [Model configuration](#model-configuration))
- Optional: cmux, for the terminal-agent coordination features
- Optional: a voice input source, either Wispr Flow or a native wake-word helper

Current platform support: macOS.

## Development

```bash
pnpm install
pnpm run check
pnpm run typecheck
pnpm test
```

Start the local daemon:

```bash
ALFRED_LOCAL_TOKEN=dev-local-token pnpm run daemon
```

Start Alfred 2 with a voice listener:

```bash
# Default path: Wispr Flow transcript listener
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

Native listener privacy boundary: passive wake detection happens locally in the helper, passive audio is not saved, and Alfred only sends the post-wake command transcript to `/ask`. On macOS, any helper that keeps the microphone open for wake detection should trigger the system mic indicator while it runs.

By default Alfred binds `127.0.0.1:47321` and serves the built React dashboard at `http://127.0.0.1:47321/dashboard`.

`pnpm run alfred2` builds `web/` before starting. For frontend development, run Alfred in one terminal and Vite in another:

```bash
ALFRED2_LISTENER=off node --experimental-strip-types src/alfred-2/cli.ts
pnpm run web:dev
```

Vite runs at `http://127.0.0.1:5173/dashboard/` and proxies the Alfred APIs to port `47321`.

## Model configuration

Alfred is an LLM agent and needs an OpenAI-compatible chat endpoint. The `alfred2` entrypoint exits if no API key is set.

```bash
# Required
export ALFRED_LLM_API_KEY="..."

# Optional, with defaults shown
export ALFRED_LLM_ENDPOINT="https://api.deepseek.com/v1"
export ALFRED_LLM_MODEL="deepseek-chat"
```

The defaults point at DeepSeek. Any OpenAI-compatible provider works, including a local server. `OPENAI_API_KEY` is also accepted as a fallback for the key, and the older `ALFRED_AI_*` names are still read.

Additional knobs: `ALFRED_LLM_MAX_TOKENS`, `ALFRED_LLM_TEMPERATURE`, `ALFRED_LLM_TIMEOUT_MS`, `ALFRED_LLM_THINKING_LEVEL`, `ALFRED_LLM_ENABLED`, and `ALFRED_SPEECH_FORMATTER_MODEL`. See `.env.example` for a starting point.

## Daemon configuration

- `ALFRED_HOST` — loopback bind host (`127.0.0.1`, `localhost`, or `::1`), default `127.0.0.1`.
- `ALFRED_PORT` — bind port, default `47321`.
- `ALFRED_LOCAL_TOKEN` — local auth token for authenticated API calls.

If `ALFRED_LOCAL_TOKEN` is not set, the daemon generates a process-local token, prints it once after startup, and does not persist it. The dashboard URL intentionally does not include tokens; enter the token manually in the dashboard.

## Memory boundaries

- **Profile** facts are durable in `~/.alfred/profile.json`, carry stable IDs and write-time provenance, and are managed from the Memory page or the compatible `remember`/`recall` tools.
- **Session** taxonomy records are sanitized, bounded, and process-scoped. Alfred's separate durable activity history may retain bounded request/response and tool metadata.
- **Reviewed extraction** runs only when you select current-session user requests on the Memory page. Its deterministic preference/identity candidates are process-only, expire after 15 minutes, and require individual accept, edit-and-accept, or reject decisions. Assistant and tool output, Knowledge, history, handoffs, files, secrets, and sensitive facts are excluded. Auto-confirm cannot accept candidates; accepted facts use atomic create-only profile writes, so existing manual facts are never replaced. Existing conflicts must be reconciled through the separate revision-checked Profile edit flow; rejected candidates and superseded-value history are not persisted.
- **Knowledge** imports local Text/Markdown content into `~/.alfred/knowledge/sources.json` and deterministic chunks in `chunks.jsonl`. Retrieval is lexical-first, source deletion and reindexing are supported, and `search_knowledge` returns request-scoped citations. The confirmation-gated `import_knowledge` tool can import a workspace file through conversation or save explicitly requested, visibly labeled assistant notes. Embeddings remain intentionally deferred.
- **Notes** are ordinary, user-owned `.md` or `.txt` files under `~/Documents/Alfred Notes`. Ask Alfred to "save this as a note" and the confirmation-gated `save_note` tool writes the exact content and attempts to open it in the default macOS app. `list_notes`, `read_note`, and `open_note` let Alfred reference those documents later or open the folder for you; notes remain directly editable and copyable in Finder and are not silently indexed as Knowledge. Existing files require an explicit confirmed overwrite; if opening fails, Alfred keeps the verified file and reports its exact path.

Profile, history, knowledge, and note files are stored with owner-only permissions. Dashboard profile writes use `POST /dashboard/facts`; stable-ID deletion uses `DELETE /dashboard/facts/:id`. Reviewed extraction uses `POST /api/memory/candidates/extract` plus candidate-specific `/accept` or `/reject` endpoints; candidates never appear in `/dashboard/state`. Knowledge sources use `GET/POST /api/memory/knowledge/sources`, `DELETE /api/memory/knowledge/sources/:id`, `POST /api/memory/knowledge/sources/:id/reindex`, and `POST /api/memory/knowledge/search` (with compatible `/dashboard/knowledge/*` aliases). Imports are limited to 2 MiB per source, 200 sources, and 50 MiB total; private memory mutations require JSON from a loopback origin. `/dashboard/state` exposes canonical grouped memory state while retaining the legacy `profileFacts` and `memoryTurns` fields during migration.

## Speed knobs

- `ALFRED_SPEECH_FORMATTER_ENABLED=auto` — only runs the optional speech-polishing LLM pass for screen-like or markup-heavy responses. Use `1`/`true` to always polish or `0`/`false` to never polish.
- `ALFRED_SILENT=1` or `ALFRED_SILENT_TESTS=1` — disables TTS playback. `pnpm test` sets test silence automatically, and Node's test runner is auto-detected.
- `ALFRED_CONTEXT_CACHE_MS=120000` — keeps full cmux/git context warm for two minutes.
- `ALFRED_CONTEXT_WORKSPACE_LIMIT=5` — inspects only the most recent and relevant workspaces per full-context request.
- `ALFRED_PR_WATCHER=1` — polls GitHub unread notifications for PRs authored by you, notifies via Alfred, and appends simple entries to `~/.alfred/pr-watch-memory.md`.
- `ALFRED_PR_WATCH_INTERVAL_MS=120000` — PR watcher poll interval; minimum 30000 ms.
- `ALFRED_WORK_ADVISOR=1` — opt in to periodic evidence-gated work reviews. Background observation stays disabled unless `ALFRED_WORK_ADVISOR_WORKSPACE` is also set; explicit user-requested reviews remain available without it.
- `ALFRED_WORK_ADVISOR_WORKSPACE=workspace:1` — exact cmux workspace ref covered by the background-observation grant. Alfred skips polls when that workspace is not selected.
- `ALFRED_WORK_ADVISOR_INTERVAL_MS=600000` — work-advisor poll interval; default ten minutes, minimum one minute. Spoken work tips are capped at two per day and use the shared mute, meeting, dedupe, and cooldown policy. Terminal text is sent to the configured LLM after best-effort secret redaction but is never persisted.

## Goals and schedules

Durable goals and bounded schedules are stored in `~/.alfred/goals-and-jobs.json`. Describe goals, reminders, completions, cancellations, or requests for work advice naturally; the model selects strict `create_goal`, `update_goal`, `schedule_job`, `cancel_scheduled_job`, or `review_current_work` tools rather than relying on command-phrase regexes. Scheduled jobs can only deliver reminders or request a work review; they cannot execute shell commands or tools.

Autonomy is deliberately scoped rather than global. Alfred 2 routine-mutation auto-approval lasts only for the current server session; session monitors separately store `replyMode: "draft" | "send"` for one exact target; daemon-owned loops separately report whether their source has the privileged `loop.autonomousSend` capability. Enabling one scope never enables another. The dashboard changes routine-mutation posture through `PUT /api/settings/autonomy` rather than conversational approval text.

## Smoke commands

```bash
curl -s http://127.0.0.1:47321/health
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/state
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/surfaces
```

## Google integration

```bash
# Put your OAuth Desktop App JSON here first:
# ~/.alfred/google/oauth-client.json
pnpm run google:auth
```

The Google integration is read-only by default and uses `GOOGLE_OAUTH_CLIENT_PATH`, `GOOGLE_OAUTH_TOKEN_PATH`, and `GOOGLE_SCOPES` from `~/.alfred/daemon.env` when present. Enable Gmail, Calendar, Docs, and Drive APIs in the same Google Cloud project before authorizing.

## Source layout

```text
src/alfred-2/    Agent core, HTTP server, memory, speech, tools, watchers
src/contracts/   Shared request/response/action/event contracts
src/cmux/        cmux world-model adapter
src/core/        Alfred core runtime
src/daemon/      daemon/server
src/cli/         CLI
src/planner/     action planner
src/router/      deterministic intent router
src/storage/     local persistence
web/             React/Vite dashboard
test/            tests (node --test)
```
