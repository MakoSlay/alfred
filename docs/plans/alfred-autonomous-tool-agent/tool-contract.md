# Alfred Autonomous Tool Contract

Status: phase-001 contract. Execution is enabled incrementally in later tasks.

## Turn Protocol

Each LLM turn must be exactly one JSON object:

- Final response: `{ "speech": "Short spoken answer, sir.", "displayText": "Optional detailed text" }`
- Tool call: `{ "tool": "bash", ...tool arguments... }`

The parser accepts strict JSON, a single fenced JSON block, complete `<think>...</think>` removal, and one balanced JSON object with harmless prose before/after. It never executes malformed, ambiguous, schema-invalid, or unknown-tool output. Retryable parser failures get one repair prompt; repeated failure returns a graceful final response and executes nothing.

## First Phase Tools

Registered tools:

- `bash`: `{ tool, command, cwd?, workspaceRef?, timeoutMs?, risk? }`
- `read_file`: `{ tool, path, cwd?, workspaceRef? }`
- `write_file`: `{ tool, path, content, cwd?, workspaceRef? }`
- `edit_file`: `{ tool, path, oldText, newText, cwd?, workspaceRef? }`
- `web_search`: `{ tool, query, numResults? }` (Exa via `EXA_API_KEY`, default 5, max 10)
- `fetch_content`: `{ tool, url }`
- `ci_status`: `{ tool, cwd?, workspaceRef? }`
- `ci_logs`: `{ tool, jobId? | runId? | jobNumber?, cwd?, workspaceRef? }`

Deferred: subagents, intercom, vision/video analysis, long-running background workers.

## Tool Context and Results

Every executed tool call receives `requestId`, `toolCallId`, resolved `cwd`/`workspaceRef` when relevant, `timeoutMs`, and `risk`.

Tool results use the common shape in `src/alfred-2/tool-types.ts`: `success`, concise `text`, optional structured `data`, `displayText`, truncation metadata, `retryable`, timing, cwd/workspace, and safety metadata.

## Workspace/CWD Contract

cmux is source of truth for where Alfred acts. Conversation memory is source of truth for what the user refers to. Alfred's own process cwd/repo is never an implicit fallback unless the user explicitly asks for Alfred.

Default resolution: selected cmux workspace → active pane cwd → active git repo root for repo operations. If cmux is unavailable, read-only app/system requests may proceed with a warning; repo/file/CI operations ask or fail safely.

## Safety and Confirmation

Risk levels: `read`, `external`, `mutation`, `destructive`.

No confirmation for diagnostic/read-only commands such as `git status`, `git diff`, `git log`, `gh pr view`, `npm test`, `pytest`, `ruff`, `tsc`. Confirmation is required for mutating git/package/file operations. Extra explicit confirmation is required for destructive actions (`rm`, `sudo`, `kill`, `git reset --hard`, `git clean`, force push, branch deletion).

Confirmation stores exact payload plus hash, deterministic preview, confirmation id, created/expiry timestamps, and risk. Confirmation executes the stored payload/hash, never a regenerated LLM response. Bare “yes/confirm/go ahead” is valid only when exactly one pending confirmation exists.

## Session Accounting

An Alfred session is the server process lifetime. Track cumulative input + output tokens for every LLM call, including system/context/tool definitions/tool results. Prefer provider-reported usage; estimate otherwise. Warn/prep at 80k tokens and generate a deterministic handoff at 100k tokens under `~/.alfred/handoffs/` using the filename format in `implementation-defaults.md`.

## Display Surfaces

- `speech`: short spoken answer only.
- `displayText`: full API/HTTP detail.
- macOS notification: short summary (cap roughly 200 chars), never logs/diffs/secrets.
- terminal logs: developer diagnostics.

## Defaults

Initial constants are represented in `ALFRED_AUTONOMOUS_DEFAULTS`: max tool rounds 8, request budget 10 minutes, standard bash 30s, tests/builds 5 minutes, output limit 64 KiB, confirmation TTL 5 minutes, destructive TTL 1 minute, Exa web provider, and test files under `test/*.test.ts`.
