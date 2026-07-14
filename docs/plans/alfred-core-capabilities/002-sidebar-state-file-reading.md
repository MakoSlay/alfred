# 002 - Sidebar State & File Reading

## Goal

Register `cmux.sidebarState` and `cmux.listStatus` as safe read-only actions, add `read_file` capability for reading file contents (not just opening files), and expose all three through the planner and deterministic router.

## Dependencies

- Requires: 001 (readSurface establishes the pattern)
- Blocks: 005, 009, 010

## Scope

**In scope:**
- Register `cmux.sidebarState` as safe action (read-only — returns git branch, dirty status, PR info, ports, cwd, focused panel, progress)
- Register `cmux.listStatus` as safe action (read-only — returns sidebar status entries)
- Add `read_sidebar` and `list_status` planner intents
- Implement `read_file` action: uses `fs.readFile` with safe relative path validation, realpath resolution against symlink escapes, binary file detection, size limit 1MB, text only
- Add `read_file` planner intent with hardened path validation: `isSafeRelativePath` → `fs.realpathSync` → verify within cwd → reject binary extensions → reject null bytes
- Deterministic router patterns: `"what's the git status"`, `"sidebar state"`, `"read file package.json"`, `"show me tsconfig"`
- Planner prompt update with `read_sidebar`, `list_status`, and `read_file` tool shapes

**Out of scope:**
- Writing files (requires shell execution or new cmux capability)
- Binary file reading (detect and reject binary files by null bytes in first 512 bytes, or by extension blocklist: `.exe`, `.dll`, `.so`, `.dylib`, `.bin`, `.dat`, `.zip`, `.tar`, `.gz`, `.png`, `.jpg`, `.webp`, `.gif`, `.pdf`, `.o`, `.class`)
- Modifying sidebar state (already exists as `cmux.setStatus`/`cmux.setProgress`)

## Checklist

- [ ] Register `cmux.sidebarState` as safe action in action registry
- [ ] Register `cmux.listStatus` as safe action in action registry
- [ ] Implement `read_file` action using `fs.readFile` with safe relative path validation, 1MB text size limit, realpath resolution to catch symlink escapes, and binary file detection (null byte check in first 512 bytes + extension blocklist)
- [ ] Register `cmux.readFile` as safe action in action registry with hardened `validateInput`: check `isSafeRelativePath` first, then resolve realpath, verify resolved path is still within cwd, reject binary extensions, reject paths with null bytes
- [ ] Add `read_sidebar`, `list_status`, and `read_file` to `AlfredPlannerIntent` union type
- [ ] Add validation in `validatePlannerIntent` for all three new intents
- [ ] Wire `sidebarState` and `listStatus` into `ActionHandlerContext` type
- [ ] Add deterministic router patterns: `"sidebar state"`, `"what's the git status"`, `"list status"`, `"read file <path>"`
- [ ] Update planner system prompt with new tool shapes
- [ ] Add planner unit tests for new intent parsing/validation
- [ ] Add daemon integration tests for all three new actions
- [ ] Add daemon test: `read_file` rejects `../../.env` (path traversal escapes workspace)
- [ ] Add daemon test: `read_file` rejects `/etc/passwd` (absolute path outside workspace)
- [ ] Add daemon test: `read_file` rejects `~/.ssh/id_rsa` (home directory escape)
- [ ] Add daemon test: `read_file` rejects paths containing `../` after symlink resolution
- [ ] Add daemon test: unsafe file path denied for `read_file`
- [ ] Add daemon test: file too large returns error
- [ ] Add daemon test: `read_file` rejects binary files (null byte detection + extension blocklist)

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/actions.test.ts` — all pass
- [ ] Run `npm run check` — zero regressions

## Completion Criteria

- [ ] `cmux.sidebarState` returns git branch, dirty status, PR info, ports, cwd from any target's workspace
- [ ] `cmux.listStatus` returns all sidebar status entries
- [ ] `read_file` reads text file contents with safe path validation, realpath enforcement, and size limit
- [ ] Path traversal attacks (`../../.env`, `/etc/passwd`, `~/.ssh/id_rsa`, symlink escapes) are all rejected at validation
- [ ] Binary files are detected and rejected before content is returned
- [ ] All three can be triggered through both deterministic router and planner fallback
- [ ] All existing tests pass

## Notes

- `sidebarState` is workspace-scoped. If no target is specified, use current workspace context.
- `read_file` uses Node `fs.readFileSync` (wrapped in async for action registry compatibility). Paths must be safe relative paths validated by `isSafeRelativePath`. This is the only Alfred action that accesses the local filesystem directly (not through cmux), because cmux has no `readFile` equivalent.
- **Path traversal hardening (critical):** After `isSafeRelativePath` passes, resolve the path with `fs.realpathSync` and verify the resolved path is still within the process cwd. This prevents symlink escapes, `..` traversal, and absolute path injection. Any path that resolves outside cwd must be rejected.
- **Binary file rejection:** Before returning content, check the first 512 bytes for null bytes (`\x00`). If found, reject as binary. Also maintain an extension blocklist for known binary formats. This prevents accidental reads of compiled objects, archives, or images as garbled text.
- Path validation must never be bypassed by the LLM planner. The `read_file` intent's `path` field is validated the same way regardless of whether it came from deterministic routing or planner output.
- Size limit of 1MB prevents memory issues. Configurable via `ALFRED_MAX_FILE_CHARS`.
- The cmux adapter `sidebarState` method already exists at `src/cmux/index.ts:138`.
