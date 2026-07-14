# 003 - Target Memory and Alias Resolution

## Goal

Let Alfred resolve human names like "backend", "main Pi", and "review lane" to concrete cmux workspaces or surfaces.

## Dependencies

- Requires: 001
- Blocks: 004, 005, 006, 011

## Scope

**In scope:**
- Add target nickname/alias storage for cmux workspace/surface refs plus human-readable labels such as `backend`, `frontend`, `main pi`, or `review lane`.
- Resolve targets from exact refs, workspace-local aliases, global aliases, workspace titles, surface titles, recent activity, and remembered aliases.
- Prefer the least annoying user behavior: use workspace-local aliases first, global aliases as fallback, and ask clarification when ambiguous instead of guessing.

**Out of scope:**
- Autonomous sending to ambiguous targets.
- Cross-machine or cloud target resolution.

## Checklist

- [x] Define target memory records with alias, scope (`workspace` or `global`), cmux ref, target type, title snapshot, last seen time, and source.
- [x] Implement commands/API operations to remember, list, and forget aliases.
- [ ] Implement an `inspect alias <name>` UX/API operation. Deferred to alias UX follow-up.
- [x] Add resolver logic in this order: explicit ref, workspace-local alias, global alias, exact cmux title, recent target in current workspace, clarification.
- [x] Add ambiguity responses when multiple targets match a natural name.
- [x] Persist target memory using the existing local persistence rules and redaction constraints.
- [x] Surface resolved target previews in pending action proposals.

## Tests

- [x] Run `npm run typecheck` and verify target resolver types compile.
- [x] Run `npm test` and verify alias, title, direct-ref, stale-ref, and ambiguous-match cases.
- [x] Run `npm run check` and verify the full project gate passes.
- [x] Manual QA inside cmux: remember the current surface as a test alias, resolve it, then forget it.

## Completion Criteria

- [x] Alfred can resolve remembered aliases to concrete cmux refs.
- [x] Ambiguous target requests ask for clarification instead of taking action.
- [x] Target memory survives daemon restart without storing sensitive terminal content.

## Status

Implemented in the Task 003 pass. Alias inspect and richer list/filter UX remain deferred follow-ups.

## Notes

- Use cmux refs as operational handles, but keep labels human-readable in previews.
- Alfred may infer names from cmux titles for matching, but it should only persist a nickname when the user explicitly asks it to remember one.
