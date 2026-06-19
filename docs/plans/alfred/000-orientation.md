# 000 - Orientation and Boundary Map

## Goal

Understand the current Alfred-in-Pi implementation and document the boundary between the live Pi extension and the new standalone cmux-backed runtime.

## Scope

Read-only orientation plus documentation updates. No functional code changes should be made in this task.

## Checklist

- [ ] Inspect current Alfred source under `src/alfred-core/`, `src/alfred-adapters/`, and Alfred sections of `src/index.ts`.
- [ ] Document which pieces must remain available in the Pi extension during parallel development.
- [ ] Document which pieces are candidates for extraction into the standalone runtime.
- [ ] Identify current stateful responsibilities: pending drafts, last spoken text, loop state, and target memory.
- [ ] Identify current cmux dependencies and assumptions.
- [ ] Identify current LLM configuration and secret-handling boundaries without copying secrets.

## Tests

No functional tests are required because this is orientation-only. If any files outside this plan are changed, run the existing Pi extension gates.

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [ ] Notes section below is filled in with current architecture findings.
- [ ] `PLAN.md` status for this task is updated.
- [ ] No runtime behavior changed.

## Notes

_To be filled during implementation._

## Validation

_To be filled during implementation._

## Blockers

_None currently._
