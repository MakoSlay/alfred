# Alfred Jarvis Roadmap - Implementation Handoff

## Scope

Implement the Alfred Jarvis roadmap in `docs/plans/alfred-jarvis-roadmap/` without rewriting the existing daemon foundation.

Start with:

1. `docs/plans/alfred-jarvis-roadmap/001-cmux-adapter-foundation.md`
2. `docs/plans/alfred-jarvis-roadmap/002-tool-registry-permission-model.md`
3. `docs/plans/alfred-jarvis-roadmap/006-draft-confirm-action-cards.md` as the first approval-model migration target after the registry exists

Do not start dashboard polish, watchers, proactive monitoring, or browser control before the adapter and action registry are stable.

## Locked Product Decisions

- `POST /ask` is the primary Ask Alfred endpoint.
- `POST /handle` remains as a compatibility wrapper into the same ask pipeline.
- There must be one internal Ask Alfred brain, not separate dashboard/Pi/CLI behavior.
- Generic `PendingAction` is the canonical approval model once Task 006 migrates daemon/dashboard state. Task 002 defines the registry and `PendingAction` contract; Task 006 makes it the source of truth.
- Message drafts are editable pending actions after the Task 006 migration, not a separate long-term source of truth.
- User-facing proactive automations are called **watchers**.
- Internal recipe/schema code is acceptable, but UI/docs should say watcher.
- Active watchers clear on daemon restart.
- Persisted watcher configuration, target memory, audit history, and safe metadata may remain.
- Watchers may auto-send only when explicitly started with scoped permission for that watcher, target, action/message type, frequency, and lifetime.
- Browser read/open/snapshot is safe by default.
- Browser click/type/eval requires confirmation or a temporary scoped permission grant.
- Target nicknames are user aliases for cmux targets. Workspace-local aliases win, global aliases are fallback, exact cmux titles/recent targets can help resolution, and ambiguity asks clarification.
- Safe local cmux read/open/show actions can run directly.
- Confirmation is required for terminal sends, keypresses, shell execution, browser mutation without a temporary grant, close/delete/clear destructive state, and watcher auto-send startup.

## Recommended Implementation Order

### Phase 1: Typed cmux adapter

Primary files:

- `src/cmux/index.ts`
- `test/cmux.test.ts`

Add typed methods for cmux primitives Alfred will use:

- identify/capabilities/tree/workspaces/panes/surfaces
- terminal read/send/key
- notifications list/open/dismiss/mark-read/jump/clear
- sidebar status/progress/log/sidebar-state
- markdown/diff/file/url/browser open/read-only actions

Verified command shapes from local cmux:

- `cmux capabilities`
- `cmux identify --id-format both`
- `cmux workspace list --json --id-format both`
- `cmux tree --workspace <ref> --json --id-format both` with text fallback
- `cmux list-notifications --json --id-format both`
- `cmux sidebar-state` emits key/value text, not JSON
- sidebar writes use `set-status`, `set-progress`, `clear-progress`, `log`, and `list-status`
- rich UI opens use `markdown open`, `diff`, `open`, and `browser open`

Rules:

- Keep all cmux command execution centralized in `src/cmux/index.ts`.
- Preserve argument-array execution, timeouts, and structured `CmuxResult<T>` failures.
- Verify actual installed cmux CLI syntax before locking fixtures.
- Treat `cmux events` as optional; provide polling fallback.

### Phase 2: Action registry and permissions

Primary files:

- new `src/actions/index.ts`
- `src/contracts/runtime.ts` only if shared runtime contracts are needed immediately
- tests for action policy and registry behavior

Daemon/storage integration can be deferred to Tasks 004-006 unless it is necessary to preserve current behavior.

Add registry metadata and policy foundation:

- id
- description
- input schema/validator
- risk level
- required source and target capabilities
- preview builder
- handler seam
- audit category
- denial reasons
- temporary grant shape
- `PendingAction` contract/proposal lifecycle, without yet replacing daemon `pendingDrafts`

Risk model:

- `safe`: read/list/show/open local cmux UI, read notifications, write Alfred sidebar telemetry
- `confirmation_required`: send text, keypress, shell, close/delete/clear, watcher auto-send startup
- `restricted`: browser click/type/eval unless covered by a temporary scoped grant

### Phase 3: PendingAction migration

This is where `PendingAction` becomes canonical. Do not consider Task 002 complete as a draft-confirm migration unless Task 006 work is also done.

Primary files:

- `src/contracts/runtime.ts`
- `src/daemon/index.ts`
- `src/dashboard/index.ts`
- tests for approve/edit/cancel/stale/double-submit

Migrate pending drafts into generic pending actions:

- `cmux.sendText` pending action supports editable message body.
- Approval revalidates capabilities, live target, expiry, and idempotency.
- Existing API compatibility may expose derived `pendingDrafts` temporarily, but `PendingAction` is the source of truth.

### Phase 4: Ask pipeline and router

Primary files:

- new `src/router/index.ts`
- `src/daemon/index.ts`
- `src/dashboard/index.ts`

Implement:

- `POST /ask` as primary endpoint
- `/handle` wrapper into same ask pipeline
- deterministic router that returns safe answer, safe direct action, pending action, clarification, or error
- dashboard Ask Alfred input

### Phase 5: Watchers, notifications, sidebar, summaries, rich cmux UX

Only after phases 1-4:

- add target nicknames/aliases
- bridge native cmux notifications
- publish watcher/loop state to cmux sidebar
- add watcher recipe system and proactive watchers
- add current-state summary
- add rich cmux UI actions
- polish dashboard and command palette

## Validation

Run after each implementation slice:

```bash
npm run typecheck
npm test
npm run check
```

Manual smoke:

```bash
ALFRED_LOCAL_TOKEN=dev-local-token npm run daemon
curl -s http://127.0.0.1:47321/health
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/state
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/surfaces
```

Manual cmux checks should compare Alfred adapter output against native cmux commands for each newly supported primitive.

## Stop and Ask Before Changing

Escalate before implementation if a decision is needed on:

- exact capability names
- whether to add a frontend build system
- multi-loop watcher concurrency
- user-authored watcher recipes
- external credentials for CI/PR watchers
- making active watchers survive daemon restart
- allowing browser mutation without temporary scoped grants

## Implementation Meta-Prompt

You are implementing the Alfred Jarvis roadmap in `/Users/muhammadabdul/work/alfred`. Treat the existing daemon as a stable foundation. Start with `001-cmux-adapter-foundation.md` and `002-tool-registry-permission-model.md`. Keep all cmux execution centralized in `src/cmux/index.ts`. Add a typed action registry before adding new UI or watchers. In Task 002, define `PendingAction` and policy semantics; in Task 006, migrate message drafts into editable pending actions and make `PendingAction` canonical. Use `POST /ask` as the primary Ask Alfred endpoint and keep `/handle` as a wrapper into the same pipeline. Safe cmux read/open/show/sidebar actions may execute directly; terminal send, keypress, shell, destructive close/delete/clear, browser click/type/eval without temporary grant, and watcher auto-send startup require confirmation. Preserve local auth, draft-confirm safety, no raw transcript/secret persistence, cmux best-effort fallback, and Pi-local fallback. Verify installed cmux CLI syntax before committing adapter fixtures. Run `npm run typecheck`, `npm test`, and `npm run check` before finishing.
