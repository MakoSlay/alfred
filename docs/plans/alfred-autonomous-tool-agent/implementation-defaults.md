# Implementation Defaults

These defaults answer plan-level details that do not need user preference. They can be changed later through config if needed.

## Exa Web Search Defaults

Use Exa direct API as the first implementation.

Implementation choice: use raw `fetch` against Exa's HTTP API first, not an SDK. This avoids adding dependency weight until we need SDK-only features.

Environment:

- `EXA_API_KEY` in `~/.alfred/daemon.env`

Search behavior:

- endpoint: Exa direct search API
- default results: 5
- max results: 10
- search type: automatic/default Exa behavior unless a specific type is needed later
- return structured results: title, URL, snippet/summary, published date when available, provider metadata
- the main Alfred LLM produces the final spoken answer from structured search results

Content fetching behavior:

- If Exa content retrieval is available for a URL/result, prefer it.
- Otherwise fall back to plain HTTP fetch + simple readable text extraction.
- Start without `jsdom`/`@mozilla/readability`; add a readability dependency later only if simple extraction is insufficient.
- `fetch_content` should be separate from `web_search`; search finds sources, fetch reads a known source.

## Parser Retry Prompt

When the parser receives a retryable parser error, ask the LLM to repair format exactly once with this style of prompt:

```text
Your previous response could not be parsed: <schema error>.
Return exactly one JSON object and nothing else.
Valid final response: {"speech":"..."}
Valid tool call: {"tool":"<registeredTool>", ...tool arguments...}
Registered tools: <tool names>.
Do not use Markdown fences, prose, or multiple JSON objects.
```

If the retry also fails, Alfred returns a graceful parser failure and executes nothing.

## Handoff File Defaults

Save handoffs under:

```text
~/.alfred/handoffs/
```

Filename format:

```text
YYYY-MM-DDTHH-mm-ss-session-<sessionId>-request-<requestId>.md
```

Example:

```text
2026-06-29T18-42-00-session-a1b2c3-request-r9x8y7.md
```

Handoff content should include:

- task overview
- current state
- recent decisions
- active workspace/cwd
- files/tools touched
- pending confirmations
- completed tool calls in current request if mid-request
- next recommended step
- commands/tests already run
- known risks/gotchas

## Session Boundary Defaults

A session is the lifetime of the Alfred 2.0 server process.

New session starts when:

- Alfred server restarts
- user explicitly clears/resets session memory
- Alfred reaches the 100k token handoff threshold and the user continues fresh

Persisted command history can survive restarts, but prompt conversation memory and active session token count do not carry over automatically except through generated handoff files.

## Confirmation Expiry Defaults

Pending confirmations expire automatically.

- normal edits/mutations: 5 minutes
- destructive operations: 1 minute
- package/git mutations: 5 minutes unless classified destructive

Expired confirmations must be regenerated and re-reviewed by the user.

## Config Defaults

Primary config remains:

```text
~/.alfred/daemon.env
```

New env vars:

- `EXA_API_KEY`
- `ALFRED_SESSION_WARN_TOKENS` default `80000`
- `ALFRED_SESSION_HANDOFF_TOKENS` default `100000`
- `ALFRED_BASH_TIMEOUT_MS` default `30000`
- `ALFRED_TEST_TIMEOUT_MS` default `300000`
- `ALFRED_BUILD_TIMEOUT_MS` default `300000`
- `ALFRED_CONFIRMATION_TTL_MS` default `300000`
- `ALFRED_DESTRUCTIVE_CONFIRMATION_TTL_MS` default `60000`
- `ALFRED_WORKSPACE_ALIASES_PATH` default `~/.alfred/workspace-aliases.json`

## Fuzzy Workspace Matching Defaults

Start with alias-list matching plus simple normalized string similarity.

Algorithm:

1. lowercase input;
2. strip punctuation;
3. normalize whitespace;
4. check exact alias match;
5. check known spoken variants from alias config;
6. apply simple edit-distance or token similarity only when there is one clearly best match;
7. ask if two candidates are close.

Do not use fuzzy matching for destructive actions unless the resolved workspace is also the active cmux workspace or the user confirms explicitly.

## Workspace Alias Config Defaults

Alias map lives at:

```text
~/.alfred/workspace-aliases.json
```

Shape:

```json
{
  "main": ["main", "maine"],
  "sandbox": ["sandbox"],
  "backend": ["backend"],
  "frontend": ["frontend"],
  "alfred": ["alfred"],
  "powerco": ["powerco", "power co"]
}
```

Keys are canonical aliases. Values are spoken variants. Alfred resolves canonical/spoken aliases to cmux workspace refs at runtime.

## Secret Redaction Defaults

Before tool output is sent to the LLM or stored in prompt memory, apply best-effort redaction for common secret patterns:

- Bearer tokens: `Bearer <token>`
- API key assignments: `*_API_KEY=...`, `api_key: ...`
- generic tokens: `token=...`, `access_token=...`, `refresh_token=...`
- AWS access keys: `AKIA...`
- GitHub tokens: `ghp_...`, `github_pat_...`
- OpenAI-style keys: `sk-...`
- private key blocks: `-----BEGIN ... PRIVATE KEY-----`
- `.env` value lines when reading sensitive files

Redaction replacement should preserve shape without value, e.g. `[REDACTED_API_KEY]`.

## Test Discovery Defaults

Keep tests in the existing repo-discovered pattern:

```text
test/*.test.ts
```

Do not create nested test paths unless `package.json` test script is intentionally updated.

## Concise cmux Cheat Sheet Default

Keep the concise cmux cheat sheet as a small TypeScript constant in `src/alfred-2/context.ts` initially. Move it to a separate markdown/json file only if it grows large or needs non-code editing.

Do not expose `cmux_help` as a first-class LLM tool initially. Instead:

- keep cached full help/reference internally;
- allow the bash tool to run targeted `cmux help`/`cmux docs` commands when needed;
- revisit a first-class `cmux_help` tool only if bash-based discovery proves unreliable.

## Notification Display Defaults

macOS notifications should be short summaries only.

- default notification body cap: 200 characters
- never put full logs, diffs, handoffs, or secrets in notifications
- full detail belongs in `displayText` or a handoff/file path

## Handoff Generation Defaults

Generate handoffs deterministically first, without an extra LLM polish pass.

Rationale: handoff generation is a safety/continuity mechanism and should not fail because another LLM call misformats or summarizes away critical state.

A later task may add optional LLM-polished handoffs if deterministic handoffs are too hard to read.

## Confirmed Edit Execution Default

Confirmed edits execute the stored exact payload immediately. Do not re-preview or regenerate on confirmation.

If the underlying file changed since the confirmation preview was generated, the edit tool should fail safely when exact `oldText` no longer matches.

## cmux Help Migration Default

Until `context-model.md` is implemented, existing full `cmux help` injection may remain to avoid regressions.

After the context-model task is implemented:

- remove full `cmux help` from every prompt;
- inject concise cmux cheat sheet;
- cache full help internally;
- fetch targeted help on demand.
