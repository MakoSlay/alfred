# 005 - First-Class File Tools

## Goal

Add safe first-class file read/write/edit tools so Alfred can modify projects like pi without relying on fragile shell redirection.

## Dependencies

- Requires: 001, 003
- Blocks: 008, 009

## Scope

**In scope:**
- Implement `read_file` with offset/limit, binary detection, size limits, and clear truncation metadata.
- Implement `write_file` for new/overwrite writes with parent directory creation.
- Implement `edit_file` using exact text replacement, including multiple non-overlapping edits.
- Return structured edit failure reasons. If `oldText` is duplicated, mark the failure retryable and instruct the LLM to retry with a narrower, more unique excerpt rather than repeating the same edit.
- Resolve paths according to `workspace-resolution.md`: current cmux workspace active repo root by default, never Alfred's own repo unless named.
- Add path safety checks, overwrite detection, secret-path handling, and risk metadata using `operational-decisions.md`.
- Add diff/preview summaries for mutating file tools.
- Require confirmation for all edits in this phase; allow new-file creation without confirmation only when explicitly requested and clearly inside the current workspace.

**Out of scope:**
- Image reading/vision.
- Semantic patch generation beyond exact replacements.
- Git staging/committing.
- Editing outside selected workspace/cwd without explicit confirmation.

## Checklist

- [x] Create `src/alfred-2/tools/file.ts` or equivalent file-tool module.
- [x] Implement path resolution and safety validation against the chosen cwd/workspace using `workspace-resolution.md`.
- [x] Implement `read_file(path, offset?, limit?)`.
- [x] Implement `write_file(path, content)` with parent creation and overwrite risk metadata.
- [x] Implement `edit_file(path, edits[])` with unique exact-match validation and explicit failure codes: missing_match, duplicate_match, overlapping_edits, unsafe_path.
- [x] Enforce confirmation for all edits and existing-file overwrites.
- [x] Add diff/preview output for writes and edits.
- [x] Add prompt examples for reading, editing, and writing files.

## Tests

- [x] Add test: read file with offset/limit.
- [x] Add test: binary/oversized file is rejected or truncated safely.
- [x] Add test: edit exact replacement succeeds.
- [x] Add test: edit fails when oldText is missing, duplicated, or overlapping.
- [x] Add test: duplicate oldText failure returns retryable guidance telling the LLM to narrow oldText instead of retrying the same payload.
- [x] Add test: unsafe path attempts are blocked.
- [x] Add test: relative paths resolve against current cmux workspace active repo root.
- [x] Add test: read-only guesses announce the selected workspace; all edits require confirmation; destructive file operations require explicit confirmation.
- [x] Add test: `.env`/dotfiles require confirmation, `.ssh`/system config paths are hard-blocked.
- [x] Run `npm run check`.

## Completion Criteria

- [x] Alfred can safely read and precisely edit project files by voice.
- [x] File edits are auditable in history with a compact diff/preview.
- [x] Unsafe or ambiguous edits fail closed with a clear spoken/displayed explanation.

## Notes

- Use pi's `edit` semantics as the model: exact replacements, no fuzzy guessing inside the tool.
