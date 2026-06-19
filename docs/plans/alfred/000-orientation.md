# 000 - Orientation and Boundary Map

## Goal

Understand the current Alfred-in-Pi implementation and document the boundary between the live Pi extension and the new standalone cmux-backed runtime.

## Scope

Read-only orientation plus documentation updates. No functional code changes should be made in this task.

## Checklist

- [x] Inspect current Alfred source under `src/alfred-core/`, `src/alfred-adapters/`, and Alfred sections of `src/index.ts`.
- [x] Document which pieces must remain available in the Pi extension during parallel development.
- [x] Document which pieces are candidates for extraction into the standalone runtime.
- [x] Identify current stateful responsibilities: pending drafts, last spoken text, loop state, and target memory.
- [x] Identify current cmux dependencies and assumptions.
- [x] Identify current LLM configuration and secret-handling boundaries without copying secrets.

## Tests

No functional tests are required because this is orientation-only. If any files outside this plan are changed, run the existing Pi extension gates.

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [x] Notes section below is filled in with current architecture findings.
- [x] `PLAN.md` status for this task is updated.
- [x] No runtime behavior changed.

## Notes

### Orientation inputs inspected

Read-only inspection covered the current live Alfred-in-Pi implementation in `/Users/muhammadabdul/work/pi-smart-voice-notify`:

- `src/alfred-core/types.ts` — current Pi-local request/result/state/action and port interfaces.
- `src/alfred-core/state.ts` — in-memory state helpers and pending confirmation TTL.
- `src/alfred-core/router.ts` — deterministic command router, LLM fallback, draft/confirm/send flow, ambiguity handling, and action proposal handling.
- `src/alfred-adapters/cmux.ts` — current cmux workspace/chat adapter plus git/GitHub status helpers.
- `src/alfred-adapters/llm.ts` — OpenAI-compatible LLM adapter, action-planning prompt, structured action parsing, and delegation loop step planner.
- `src/index.ts` Alfred sections — Pi command registration, TTS/reporting, reminder integration, command queue, and active delegation loop runtime.
- Existing tests under `src/alfred-core/__tests__/` and `src/alfred-adapters/__tests__/` were searched for current behavior coverage, including the Powerco/Power Code draft-confirm flow.

The Pi repo had existing uncommitted changes before this task started. This task did not modify that repo.

### Must remain available in the Pi extension during parallel development

The current Pi extension remains the live/default `/alfred` user path. The following behavior must continue to work until an opt-in daemon bridge replaces it safely:

- `/alfred` and `/a` command registration in `src/index.ts`, including serialized execution through `alfredCommandQueue`.
- Spoken/visible response behavior through `speakAndReportAlfredResponse`, including TTS, UI notification, and debug logging.
- Reminder controls currently handled by Alfred:
  - acknowledge/seen behavior that cancels reminder activity;
  - `quiet`/`snooze` for a duration;
  - `resume reminders`/`unmute`;
  - `why are you bothering me` explanation backed by Pi reminder state.
- Pi-local in-memory Alfred state while the extension is running:
  - `alfredCoreState`;
  - `alfredLastSpokenText`;
  - last target/draft/sent memory;
  - pending draft confirmations.
- Current draft-confirm-send safety flow:
  - command or LLM proposal drafts a message;
  - Alfred asks whether to send;
  - only explicit confirmation sends text through cmux;
  - failed sends report failure instead of claiming success.
- Existing target resolution for cmux workspaces and chats/tabs, including current chat/workspace, named workspace, named chat/tab/session, fuzzy tab matching, and ambiguity prompts.
- Current deterministic status commands for workspace listing, git status, changed files, dirty workspaces, branch comparison, and PR status.
- Existing autonomous Pi-chat delegation loop behavior in `src/index.ts`, including direct current/named chat loop commands, loop status, loop stop, max-turn/time/idle limits, session transcript observation, and `ctrl+c` interruption on stop.
- Current LLM fallback behavior and structured action proposals, including the recent Powerco/Power Code named-chat flow.

Any Pi bridge to the standalone daemon must be opt-in and fail closed back to this existing Pi-local path when the daemon is missing, disabled, or unhealthy.

### Extraction candidates for standalone Alfred

The current code splits naturally into reusable concepts but should not be copied blindly because the new runtime needs non-Pi sources and a broader target/action model.

Strong extraction/reference candidates:

- Core action contracts and result shape from `src/alfred-core/types.ts`, especially request/result/action/state concepts, pending confirmations, and target memory.
- State helpers from `src/alfred-core/state.ts`, especially pending confirmation TTL and the pattern of normalizing expired pending work before handling a request.
- Draft-confirm-send flow from `src/alfred-core/router.ts`:
  - `draftMessage` / `updateDraftMessage`;
  - `sendMessage`;
  - `targetFromPendingConfirmation`;
  - ambiguity-to-pending-confirmation flow.
- cmux adapter concepts from `src/alfred-adapters/cmux.ts`:
  - workspace list/current/resolve;
  - surface/chat list/current/find/read/send;
  - use of stable `workspace:*` and `surface:*` refs;
  - explicit `ok/error` result from sends.
- LLM action-planning pattern from `src/alfred-adapters/llm.ts`:
  - separate normal reply vs action planning;
  - strict JSON proposal parsing;
  - visible workspace/chat context;
  - never claiming action execution until the host confirms it.
- Delegation loop concepts from `src/index.ts`:
  - active loop state machine;
  - transcript observation;
  - loop controller decisions (`wait`, `reply`, `done`, `needs_user`);
  - max-turn/time/idle guardrails.

Likely Pi-specific pieces that should stay behind a Pi bridge or adapter:

- Pi command registration and `ExtensionCommandContext`/UI/TTS coupling.
- Reminder-specific state and APIs (`pendingReminders`, `cancelReminderActivity`, reminder mute state).
- Pi session manager access and Pi `.jsonl` session file parsing as the primary transcript source. The standalone runtime can support Pi metadata, but its base contract should be cmux-surface first.
- Butler speech style as a presentation/source preference rather than a daemon-wide protocol requirement.
- Diversio monolith-specific area aliases in the cmux adapter (`backend`, `frontend`, `design-system`, etc.) should become configuration or an optional plugin, not hardcoded core Alfred policy.

### Current stateful responsibilities

Current Alfred state is mostly Pi-extension in-memory state with no durable event history:

- `AlfredState` in `src/alfred-core/types.ts` stores:
  - last target kind/workspace/surface;
  - last draft message;
  - last sent message;
  - last spoken text;
  - optional pending confirmation.
- `AlfredPendingConfirmation` stores draft/send and ambiguity state:
  - `kind`: `send_message`, `replace_draft`, or `choose_workspace`;
  - target refs/titles;
  - candidate workspace/surface refs/titles for ambiguity;
  - `actionIntent` for send/git status/what changed continuation;
  - draft text and optional area;
  - `expiresAt`.
- `DEFAULT_PENDING_CONFIRMATION_TTL_MS` is 5 minutes; `normalizeState` clears expired confirmations.
- `src/index.ts` additionally owns:
  - `alfredLastEventType` / `alfredLastEventTime` for attention explanations;
  - `alfredLastSpokenText` and `alfredCoreState` synchronization;
  - `alfredAgentActive` and `alfredTurnCount` for broader extension activity state;
  - `reminderMuteUntil` for reminder muting;
  - `activeDelegationLoop` with loop id, target, goal, silent flag, max turns, turn count, timestamps, last transcript, observation mode, optional target session file, entry index, idle polls, timer, and status.

Standalone Alfred should make these responsibilities explicit and durable enough for CLI/web/Pi consumers: pending drafts, confirmations, loops, action history, source attribution, target memory, and retention/redaction policy.

### Current cmux dependencies and assumptions

The current adapter shells out to the `cmux` executable and assumes these commands and output shapes:

- `cmux workspace list --json --id-format both` returns JSON with workspace ids, refs, titles, selected state, and `current_directory`.
- `cmux identify --id-format both` returns caller/focused workspace/surface/tab identifiers; env `CMUX_WORKSPACE_ID` can override current workspace discovery.
- `cmux tree --workspace <workspaceRef>` prints terminal surfaces in lines matching `surface <surface:n> [terminal] "<title>" [selected]`.
- `cmux read-screen --surface <surfaceRef> --scrollback --lines <n>` reads terminal scrollback.
- `cmux send --workspace <workspaceRef> <text>` plus `cmux send-key --workspace <workspaceRef> enter` sends to a workspace.
- `cmux send --surface <surfaceRef> <text>` plus `cmux send-key --surface <surfaceRef> enter` sends to a surface.
- `cmux send-key --surface <surfaceRef> ctrl+c` interrupts a delegated target.

Current assumptions and limitations to carry forward deliberately:

- Surface identity is currently a cmux ref such as `surface:10`; workspace identity is `workspace:9`.
- Chats are inferred from terminal surface titles, and Pi chats are detected by `title.startsWith("π - ")`.
- Current chat/workspace is inferred from cmux caller/focus and selection state.
- Named chat matching strips a leading `π - ` and uses exact, prefix, substring, then Levenshtein fuzzy matching.
- `listChats()` defaults to the current workspace unless a workspace ref is provided; cross-workspace targeting needs explicit handling.
- Reads and sends are privileged terminal operations and must be represented as capabilities in the standalone runtime.
- Git/PR status helpers currently depend on `git`, `gh`, workspace `currentDirectory`, and hardcoded area aliases. These are useful Alfred capabilities but should not be required for the minimal daemon.

### Current LLM configuration and secret boundaries

The Pi extension builds LLM config in `getAlfredLlmConfig()` from extension configuration:

- endpoint: `config.aiEndpoint` or `http://localhost:11434/v1`;
- model: `config.aiModel` or `llama3.2`;
- API key: `config.aiApiKey` or empty string;
- temperature, max tokens, thinking level, timeout, and personality.

The LLM adapter is OpenAI-compatible and only sends an `Authorization: Bearer ...` header when an API key is configured. It has DeepSeek-specific thinking/reasoning payload support. It catches LLM failures/timeouts and returns safe fallback speech instead of surfacing secrets.

Boundaries for the standalone repo:

- Do not copy API keys, extension config files, debug logs, transcripts, or session files into the new repo.
- Runtime configuration should come from local env/config ignored by git, not from committed source.
- Prompt text and transcript snippets are sensitive: action history should record redacted snippets, retention metadata, and redaction status.
- The daemon should separate raw LLM requests/responses from dashboard-safe summaries.
- If Pi bridges to the daemon, Pi should pass only the minimum source context needed for the request and should not expose all Pi extension configuration by default.

### Boundary map for the new standalone runtime

Near-term boundary:

```text
Pi /alfred local implementation remains default
        │
        ├─ existing in-extension core/router/adapters keep working
        │
        └─ optional future bridge, feature-flagged and fail-closed

Alfred standalone runtime
        ├─ owns contracts, state, history, capabilities, policy
        ├─ uses cmux adapter for world model and privileged sends
        ├─ exposes CLI/web/Pi/future voice source contracts
        └─ may import/reference Pi metadata through an adapter, not core coupling
```

The next task should define source, target, action, event, error, retention/redaction, and capability contracts before daemon endpoints are implemented.

## Validation

- Read-only orientation completed against `/Users/muhammadabdul/work/pi-smart-voice-notify`.
- Updated only plan documentation in `/Users/muhammadabdul/work/alfred`.
- No runtime/source files were changed.
- Pi extension gates were not run because this task did not modify `pi-smart-voice-notify` runtime or tests.

## Blockers

_None currently._
