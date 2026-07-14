# Alfred Autonomous Tool Agent

Alfred is a local, cmux-backed personal assistant that operates as an autonomous tool-loop agent. It can run bash commands, read/write/edit files, search the web, fetch web content, and query CI status/logs — all through a structured JSON tool-calling protocol.

## Configuration

Alfred is configured through environment variables.

### LLM Configuration

| Variable | Description | Default |
|---|---|---|
| `ALFRED_LLM_ENDPOINT` | OpenAI-compatible API endpoint | Required |
| `ALFRED_LLM_MODEL` | Model name to use | Required |
| `ALFRED_LLM_API_KEY` | API key for the LLM provider | Required |
| `ALFRED_LLM_TEMPERATURE` | Temperature for generation | `0` |
| `ALFRED_LLM_MAX_TOKENS` | Maximum tokens per response | `4000` |
| `ALFRED_LLM_TIMEOUT_MS` | Timeout per LLM request (ms) | `30000` |

### Web Search / Content Fetching

| Variable | Description | Default |
|---|---|---|
| `EXA_API_KEY` | Exa API key for web search and content fetching | None (disabled) |

### Daemon / Session

| Variable | Description | Default |
|---|---|---|
| `ALFRED_SESSION_ID` | Session identifier (auto-generated if absent) | Auto UUID |
| `ALFRED_HANDOFF_DIR` | Directory for session handoff files | `~/.alfred/handoffs` |
| `ALFRED_WORKSPACE_ALIASES_PATH` | Path to workspace aliases JSON | `~/.alfred/workspace-aliases.json` |

## Available Tools

Every tool call is a JSON object with a `"tool"` field. The agent responds with exactly one JSON object per turn: either a tool call or a final speech response.

### Tool JSON Contracts

#### `bash` — Execute a command
```json
{"tool":"bash","command":"echo hello","cwd":"optional","workspaceRef":"optional","timeoutMs":30000}
```
- `command` (string, required): Single-line bash command
- `cwd` (string, optional): Override working directory
- `workspaceRef` (string, optional): cmux workspace ref (e.g. `workspace:1`)
- `timeoutMs` (number, optional): Per-command timeout (default 30s)

#### `read_file` — Read a file
```json
{"tool":"read_file","path":"src/foo.ts","cwd":"optional","workspaceRef":"optional"}
```
- `path` (string, required): Relative or absolute path
- Max file size: 1 MiB
- Binary files are rejected

#### `write_file` — Create or overwrite a file
```json
{"tool":"write_file","path":"src/bar.ts","content":"export const x = 1;\n"}
```
- `path` (string, required)
- `content` (string, required): Full file content
- Parent directories are created automatically
- **Always requires confirmation**

#### `edit_file` — Targeted text replacement
```json
{"tool":"edit_file","path":"src/foo.ts","oldText":"x = 1","newText":"x = 42"}
```
- `path` (string, required)
- `oldText` (string, required): Exact text to find and replace
- `newText` (string, required): Replacement text
- `oldText` must match exactly once in the file
- **Always requires confirmation**

#### `web_search` — Search the web
```json
{"tool":"web_search","query":"Alfred the butler","numResults":5}
```
- `query` (string, required): Search query
- `numResults` (number, optional): 1–10 results (default 5)
- Requires `EXA_API_KEY` environment variable

#### `fetch_content` — Fetch web page content
```json
{"tool":"fetch_content","url":"https://example.com"}
```
- `url` (string, required): URL to fetch
- Uses Exa content retrieval when `EXA_API_KEY` is set, falls back to plain HTTP fetch
- HTML content is stripped to plain text
- Max 8,000 characters returned

#### `ci_status` — Query GitHub Actions CI status
```json
{"tool":"ci_status","cwd":"optional","workspaceRef":"optional"}
```
- Requires `gh` CLI authenticated in the workspace
- Returns PR check statuses or branch-level workflow runs
- Never falls back to Alfred's own repository

#### `ci_logs` — Fetch GitHub Actions job logs
```json
{"tool":"ci_logs","runId":12345,"jobId":"optional"}
```
- `runId` (number, required): Workflow run ID from `ci_status` output
- `jobId` (string, optional): Specific job to filter
- Logs truncated at 32 KB with head/tail excerpt
- Requires `gh` CLI authenticated

### Final Speech

```json
{"speech":"Done, sir.","displayText":"optional detail for API consumers"}
```

## Safety Model

Every tool call is classified by risk level and assigned a confirmation requirement.

### Risk Levels

| Level | Description | Example Tools |
|---|---|---|
| `read` | Read-only operations, no side effects | `read_file`, `ci_status`, `ci_logs`, diagnostic bash |
| `external` | Outbound network calls | `web_search`, `fetch_content` |
| `mutation` | Mutates files or state | `write_file`, `edit_file`, `git add/commit`, `npm install` |
| `destructive` | Can cause data loss or system damage | `rm -rf`, `sudo`, `kill`, `git push --force`, `curl \| sh` |

### Confirmation Requirements

| Requirement | Behavior |
|---|---|
| `none` | Executes immediately, no user prompt |
| `confirm` | Pauses and asks for user confirmation before executing. User must reply with confirmation ID. |
| `explicit` | Like `confirm`, but with a shorter TTL (1 minute vs 5 minutes for destructive operations). Used for destructive commands. |
| `blocked` | Refuses to execute entirely. Currently blocks: system paths (`/etc`, `/sys`, `/proc`, `/dev`, `/boot`), `.ssh` paths, AWS credential files, and `.env` files in security-sensitive locations. |

### Confirmation Execution

When a command requires confirmation:
1. The tool loop returns `requiresConfirmation: true` with a `confirmationId` and preview text
2. The exact command is stored (hashed for integrity) — it is never regenerated
3. On confirmation, the stored payload is executed verbatim
4. Expiry: 5 minutes for mutations, 1 minute for destructive operations

### Bash Command Classification

Bash commands are classified by pattern matching:
- **Read-only** (no confirmation): `git status`, `git diff`, `git log`, `npm test`, `tsc`, `pytest`, `ruff`, etc.
- **Mutation** (confirmation required): `git add`, `git commit`, `git merge`, `npm install`, `mv`, `cp`, `mkdir`, redirects
- **Destructive** (explicit confirmation): `rm`, `sudo`, `kill`, `shutdown`, `git push --force`, `curl | sh`, `chmod`, `chown`, `dd if=`

## Session Handoff

When cumulative token usage reaches the handoff threshold (default: 100,000 tokens), the agent:
1. Stops the current request
2. Writes a structured Markdown handoff file to `~/.alfred/handoffs/`
3. Returns the handoff file path

### Handoff File Content

The handoff file contains:
- Task overview (original user request)
- Current state (why the handoff was triggered)
- Recent decisions and tool outcomes
- Files and tools touched
- Pending confirmations
- Next steps
- Commands run
- Token accounting
- Full conversation summary

A fresh session can load the handoff file as context to continue where the previous session left off.

## Workspace Resolution

Alfred resolves workspaces from cmux context provided in the system prompt:
```
WORKSPACES:
  Main [current] | ref:workspace:1 | /Users/alice/project
  Sandbox | ref:workspace:2 | /Users/alice/sandbox
```

### Resolution Rules
1. **Explicit mention**: User says "use Sandbox" — Alfred uses workspace by name
2. **Fuzzy matching**: "Maine" matches "Main" (edit distance ≤ 1)
3. **Default**: Uses the `[current]` workspace
4. **Ambiguous**: When two workspaces have similar names, Alfred asks instead of guessing
5. **No fallback**: If no cmux workspace cwd is available, Alfred refuses to execute repo commands rather than falling back to its own directory

### Workspace Aliases

Custom aliases can be defined in `~/.alfred/workspace-aliases.json`:
```json
{
  "main": ["main", "maine", "prod"],
  "sandbox": ["sandbox", "sb", "sand"]
}
```

## How to Add New Tools

1. **Define the tool call type** in `src/alfred-2/tool-types.ts`:
   ```typescript
   export interface MyNewToolCall {
     tool: "my_new_tool";
     // ... tool-specific fields
   }
   ```

2. **Add to the union type and constants**:
   ```typescript
   export type AlfredToolCall = ... | MyNewToolCall;
   export const ALFRED_TOOL_NAMES = [..., "my_new_tool"] as const;
   ```

3. **Create the tool handler** in `src/alfred-2/tools/`:
   ```typescript
   export async function myNewTool(
     toolCall: MyNewToolCall,
     ctx: ToolExecutionContext,
   ): Promise<ToolResult> { ... }
   ```

4. **Classify the risk** in `src/alfred-2/risk.ts` under `classifyToolRisk`:
   ```typescript
   case "my_new_tool":
     return { risk: "read", confirmation: "none" };
   ```

5. **Wire into the tool loop** in `src/alfred-2/tool-loop.ts`:
   ```typescript
   case "my_new_tool":
     return recordToolResult(await myNewTool(toolCall, ctx), rawAssistantText);
   ```

6. **Add parser validation** in `src/alfred-2/parser.ts` under `validateToolCall`.

7. **Add tests** in `test/alfred2-*.test.ts`.

## Example Voice Commands

| Command | What Alfred Does |
|---|---|
| "Open Spotify" | Opens the Spotify app via `open -a "Spotify"` |
| "What's the weather in London?" | Fetches from wttr.in or web search |
| "Run tests in Main" | Executes `npm test` in the Main workspace |
| "Search for TypeScript generics" | Uses `web_search` to find relevant articles |
| "Read package.json" | Uses `read_file` to read the file |
| "Edit config.ts to change the port" | Uses `edit_file` for targeted text replacement |
| "Check CI status" | Uses `ci_status` to query GitHub Actions |
| "Show me the failing test logs" | Uses `ci_logs` to fetch job logs |
| "Commit my changes" | Uses `git add` + `git commit` in the workspace |
| "Clean the build cache" | Uses `rm -rf` (requires explicit confirmation) |
