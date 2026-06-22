# 002 - Tool Registry and Permission Model

## Goal

Define Alfred's action registry and permission model so future capabilities can be added safely and consistently before Ask Alfred, dashboard cards, watchers, or browser mutation expand.

## Dependencies

- Requires: 001
- Blocks: 004, 005, 006, 009, 010, 012

## Scope

**In scope:**
- Create a registry for Alfred actions such as cmux inspect, terminal send/key, notifications, sidebar updates, loop control, watcher control, markdown/diff open, file/url open, and browser entry points.
- Assign each action a risk level: `safe`, `confirmation_required`, or `restricted`.
- Define the generic `PendingAction` contract and in-memory proposal lifecycle needed by later approval UI work.
- Define preview payloads, audit event fields/categories, capability checks, policy denial reasons, temporary grants, and idempotency/expiry expectations.
- Add initial built-in registry entries and handler seams for near-term cmux actions.

**Out of scope:**
- Full sandboxing for arbitrary shell/file/browser control.
- Implementing every action handler beyond the registry and policy checks needed for near-term features.
- Migrating existing daemon `pendingDrafts` storage/API state to canonical `PendingAction`; that migration is Task 006.
- Dashboard approval-card rendering; that belongs to Task 006.
- Wiring every existing daemon action path through the registry; 002 should make this possible, while 004/005/006 perform integration.

## Checklist

- [ ] Define action metadata fields: id, description, input schema/validator, risk level, required capabilities, preview builder, handler, and audit category.
- [ ] Add permission levels for safe inspect/open/show actions, confirmation-required execution, and restricted temporary grants.
- [ ] Define `PendingAction` and temporary grant contracts without yet making them daemon API source of truth.
- [ ] Add policy validation that rejects unknown actions, invalid inputs, missing capabilities, incompatible targets, restricted actions without grants, and expired grants.
- [ ] Add proposal/execution lifecycle states for proposed, approved, edited, cancelled, denied, expired, executing, executed, and failed actions.
- [ ] Add initial built-in actions for safe cmux read/open/sidebar actions, confirmation-required terminal send/key, restricted browser mutation stubs, and loop/watcher control seams.

## Tests

- [ ] Run `npm run typecheck` and verify registry/action types compile.
- [ ] Run `npm test` and verify policy tests cover safe allowed, confirmation-required allowed-as-pending, restricted denied without grant, restricted allowed with valid grant, malformed input, unknown action, missing capability, incompatible target, expiry, cancellation, and double-submit/idempotency behavior.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA is optional for 002 if daemon integration is not included; existing draft-confirm behavior must still work and must not send directly.

## Completion Criteria

- [ ] The registry can describe and validate all action categories needed by Ask Alfred and watchers.
- [ ] Risk levels and denial reasons are deterministic and independent of any LLM/planner output.
- [ ] Risky actions can produce previews and pending proposals but cannot execute without approval, a temporary grant, or explicit watcher auto-send capability.
- [ ] Safe direct actions can be represented and executed through handlers once router/daemon integration is added.
- [ ] Existing draft-confirm behavior still works unchanged until Task 006 migrates it.

## Notes

- This task should happen before expanding browser, shell, or file actions.
- Keep deterministic validation separate from any LLM planner output.
- Safe direct actions: read/list/show/open cmux UI, read notifications, open diff/markdown/file/URL/browser surfaces, jump/focus cmux UI, and write Alfred sidebar status/progress/logs.
- Confirmation-required actions: terminal send, keypress, shell execution, destructive close/delete/clear state, and watcher auto-send startup.
- Restricted actions: browser click/type/eval unless covered by a temporary scoped grant. Browser read/open/snapshot remains safe.
- Do not claim `PendingAction` is the daemon/UI source of truth until Task 006 replaces draft-specific state and compatibility outputs are defined.
