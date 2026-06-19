# 003 - cmux World Model Adapter

## Goal

Implement the standalone runtime's cmux adapter so Alfred can discover and target workspaces, tabs, and terminal surfaces without depending on Pi extension internals.

## Scope

Build a cmux-backed world model in the new project. This should be generic enough to represent Pi, Codex, Claude, shells, and unknown terminal sessions.

## Checklist

- [x] Implement workspace listing using cmux commands or a cmux library wrapper.
- [x] Implement surface/tab listing with normalized titles and selected/current metadata.
- [x] Implement target matching for current surface, current workspace, named chat/tab, and fuzzy names.
- [x] Implement transcript/read helpers with explicit fallback/error results.
- [x] Implement send text and send key helpers with structured success/failure results.
- [x] Add tests using fixtures for Pi-like, Codex-like, and generic terminal surfaces.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [x] Adapter can list and resolve cmux targets from fixtures.
- [x] Adapter can represent Pi and Codex-like surfaces without special-casing product policy.
- [x] Send/read failures are structured, not thrown into user-facing prose.
- [x] Validation results are recorded below.

## Notes

Implemented `src/cmux/index.ts` as the standalone cmux world-model adapter.

Key behavior:

- `createCmuxWorldModelAdapter()` shells out through an injectable `execFile` boundary so tests can use fixtures and later code can swap command execution if needed.
- Workspace discovery uses `cmux workspace list --json --id-format both` and maps each workspace to an `AlfredTarget` with `kind: "cmux-workspace"`.
- Current context uses `cmux identify --id-format both`, with `CMUX_WORKSPACE_ID` support preserved for environments that provide it.
- Surface discovery parses `cmux tree --workspace <ref>` terminal surface lines and records normalized title, selected/current metadata, workspace relationship, process kind, target kind, and read/send capabilities.
- Pi-like surfaces are represented as `kind: "pi-chat"`; Codex-like surfaces are represented as `kind: "codex-session"`; shell-like surfaces are represented as `kind: "terminal"`; otherwise Alfred uses generic `cmux-surface`. This is classification metadata, not product policy: sends are not restricted to Pi-only targets at this layer.
- Matching supports current surface/chat/tab, current workspace, exact/prefix/substring matches, and Levenshtein fuzzy matching across workspace and surface labels.
- `readSurface`, `sendTextToSurface`, `sendTextToWorkspace`, and `sendKeyToSurface` return `CmuxResult<T>` structured success/failure values instead of user-facing prose.

Tests in `test/cmux.test.ts` cover Pi-like, Codex-like, and generic terminal fixtures, fuzzy/current target matching, read/send command behavior, argument preservation for shell-ish text, and structured read failure results.

## Validation

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

All passed. `npm test` ran 7 Node test cases total, including 4 cmux adapter tests.

The Pi extension repo was not modified, so Pi extension gates were not required.

## Blockers

_None currently._
