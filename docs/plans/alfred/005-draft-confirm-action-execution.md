# 005 - Draft-Confirm and Action Execution

## Goal

Make the standalone daemon safely perform Alfred's most important live workflow: resolve a target, create a draft, confirm it, and send through cmux.

## Scope

Implement deterministic draft-confirm state and action execution in the daemon. This should work from CLI/API without the Pi extension.

## Checklist

- [ ] Implement pending draft state with target, message, timestamps, and expiry.
- [ ] Implement `POST /confirm` and `POST /cancel` APIs.
- [ ] Implement send execution through the cmux adapter only after confirmation.
- [ ] Implement fallback behavior when a target disappears before confirmation.
- [ ] Implement event/history records for draft created, confirmed, sent, cancelled, and failed.
- [ ] Add tests for the Powerco/Power Code flow and `send that`/confirm behavior.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [ ] Fuzzy named-target requests can become real pending drafts.
- [ ] Confirming sends exactly once.
- [ ] Failed sends do not claim success.
- [ ] Validation results are recorded below.

## Notes

_To be filled during implementation._

## Validation

_To be filled during implementation._

## Blockers

_None currently._
