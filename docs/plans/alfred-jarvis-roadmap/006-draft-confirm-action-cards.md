# 006 - Pending Action Cards

## Goal

Migrate Alfred's approval state from draft-specific pending drafts to generic `PendingAction` records, then render and execute pending action cards so users can safely approve, edit, or cancel confirmation-required side effects.

## Dependencies

- Requires: 002, 003, 005
- Blocks: 009, 010, 013

## Scope

**In scope:**
- Make generic `PendingAction` the canonical daemon/UI approval state; message drafts become one editable pending action type.
- Preserve backward-compatible `pendingDrafts` response fields only as derived compatibility output while callers migrate.
- Replace draft-specific cards with generic `PendingAction` cards.
- Display action previews for cmux send, loop start/stop, watcher start/stop, notification actions, and safe open/show actions when a preview is useful.
- Support approve, edit where safe, cancel, and inspect-details controls.
- Revalidate target liveness, target capabilities, source capabilities, expiry, and idempotency on approval before any side effect executes.
- Persist audit events for each proposal lifecycle transition.

**Out of scope:**
- Autonomous approval policy beyond already-defined explicit capabilities.
- Complex multi-action transactions that need rollback.
- New watcher/browser capabilities beyond rendering and executing already-registered actions.

## Checklist

- [ ] Define `PendingAction` card payloads shared by daemon and dashboard, reusing the registry contract from Task 002.
- [ ] Migrate pending message drafts into editable `PendingAction` records while preserving compatible API output where needed.
- [ ] Replace `/confirm` and `/cancel` internals with PendingAction approval/cancellation while keeping legacy request shapes compatible.
- [ ] Render target, risk level, proposed command/action, and preview text clearly.
- [ ] Implement approve/cancel flows through existing authenticated daemon APIs.
- [ ] Implement edit flow for draft messages and other editable pending action fields.
- [ ] Ensure expired, stale, target-disappeared, capability-changed, or already-resolved cards cannot execute twice.

## Tests

- [ ] Run `npm run typecheck` and verify pending action card contracts compile.
- [ ] Run `npm test` and verify approve, edit, cancel, stale pending action, and double-submit cases.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA: draft a message to a remembered target, edit it in the dashboard, send it, and verify cmux receives only the confirmed text.

## Completion Criteria

- [ ] `PendingAction` is the canonical daemon/UI/API model for confirmation-required actions.
- [ ] Existing draft-confirm behavior still works through compatibility fields and never sends directly.
- [ ] Confirmation-required actions appear as cards and require explicit user approval unless a scoped temporary grant or watcher auto-send permission applies.
- [ ] Editable message drafts can be changed before execution.
- [ ] Action lifecycle events are visible in local history.

## Notes

- This is Alfred's core trust UX; avoid hidden execution paths.
- Safe read/open/show actions may execute directly when policy says they are non-destructive; confirmation-required actions must pass through pending action cards.
- Task 002 may define `PendingAction`; this task is where it becomes the source of truth for approvals and where existing `pendingDrafts` becomes derived compatibility output.
