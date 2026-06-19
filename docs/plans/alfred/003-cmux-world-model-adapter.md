# 003 - cmux World Model Adapter

## Goal

Implement the standalone runtime's cmux adapter so Alfred can discover and target workspaces, tabs, and terminal surfaces without depending on Pi extension internals.

## Scope

Build a cmux-backed world model in the new project. This should be generic enough to represent Pi, Codex, Claude, shells, and unknown terminal sessions.

## Checklist

- [ ] Implement workspace listing using cmux commands or a cmux library wrapper.
- [ ] Implement surface/tab listing with normalized titles and selected/current metadata.
- [ ] Implement target matching for current surface, current workspace, named chat/tab, and fuzzy names.
- [ ] Implement transcript/read helpers with explicit fallback/error results.
- [ ] Implement send text and send key helpers with structured success/failure results.
- [ ] Add tests using fixtures for Pi-like, Codex-like, and generic terminal surfaces.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [ ] Adapter can list and resolve cmux targets from fixtures.
- [ ] Adapter can represent Pi and Codex-like surfaces without special-casing product policy.
- [ ] Send/read failures are structured, not thrown into user-facing prose.
- [ ] Validation results are recorded below.

## Notes

_To be filled during implementation._

## Validation

_To be filled during implementation._

## Blockers

_None currently._
