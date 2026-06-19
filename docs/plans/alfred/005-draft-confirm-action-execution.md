# 005 - Draft-Confirm and Action Execution

## Goal

Make the standalone daemon safely perform Alfred's most important live workflow: resolve a target, create a draft, confirm it, and send through cmux.

## Scope

Implement deterministic draft-confirm state and action execution in the daemon. This should work from CLI/API without the Pi extension.

## Checklist

- [x] Implement pending draft state with target, message, timestamps, and expiry.
- [x] Implement `POST /confirm` and `POST /cancel` APIs.
- [x] Implement send execution through the cmux adapter only after confirmation.
- [x] Implement fallback behavior when a target disappears before confirmation.
- [x] Implement event/history records for draft created, confirmed, sent, cancelled, and failed.
- [x] Add tests for the Powerco/Power Code flow and `send that`/confirm behavior.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [x] Fuzzy named-target requests can become real pending drafts.
- [x] Confirming sends exactly once.
- [x] Failed sends do not claim success.
- [x] Validation results are recorded below.

## Notes

Implemented deterministic draft-confirm execution in `src/daemon/index.ts`.

Key behavior:

- Daemon state now owns `pendingDrafts`, recent targets, and event history.
- `POST /handle` recognizes deterministic draft requests such as the Powerco/Power Code flow and creates an `AlfredDraft` instead of sending immediately.
- `POST /handle` also treats `yes`, `send that`, `confirm`, `go ahead`, and `do it` as confirmation for the latest pending draft.
- `POST /confirm` confirms a pending draft by id, re-checks source send capability, re-validates that the target is still visible through the cmux adapter, then sends through `sendTextToSurface` or `sendTextToWorkspace` exactly once.
- `POST /cancel` cancels a pending draft and removes it from inspectable pending state.
- Expired pending drafts are pruned before request handling/state inspection.
- Target disappearance before confirmation fails closed with `target_not_found`, records `send.failed`, and does not call cmux send.
- cmux send failure records `send.failed`, returns `send_failed`, and does not claim success.
- Events now cover `draft.created`, `draft.confirmed`, `send.started`, `send.succeeded`, `send.failed`, and `draft.cancelled`.

Tests in `test/daemon.test.ts` now cover:

- Powerco fuzzy named-target draft creation without sending.
- `/confirm` sending exactly once and rejecting a second confirmation.
- `/handle` `send that` confirmation behavior.
- `/cancel` pending draft removal/history.
- Target disappearance before confirmation.
- Failed cmux send not claiming success.

## Validation

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
```

Passed. `npm test` ran 18 Node test cases total.

The Pi extension repo was not modified, so Pi extension gates were not required.

## Blockers

_None currently._
