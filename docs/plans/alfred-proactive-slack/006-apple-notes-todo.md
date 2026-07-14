# 006 — Apple Notes Todo Source of Truth

Canonical details: `IMPLEMENTATION.md#006--apple-notes-todo-source-of-truth--redesigned-mvp`.

## Verdict

Previous design was overengineered for Phase 1. It tried to solve full bidirectional sync, stable IDs, fuzzy merges, and native checklist support before proving Alfred can safely append one confirmed item.

## Phase 1 Goal

Let Alfred read `Alfred Todo` and append confirmed items to the agreed sections without corrupting manual edits.

## In Scope — Phase 1

- Read `Alfred Todo` from Apple Notes.
- Create it if missing, with confirmation.
- Parse canonical sections.
- Append a confirmed item to one section.
- Preserve all existing user text/order by only appending.
- Refuse to write if parsing is ambiguous.

## Out of Scope — Phase 1

- Full sync engine.
- SQLite `todo_item_map`.
- Fuzzy matching.
- Editing/checking/unchecking/removing existing items.
- Native Notes checklist support unless real local fixture proves it is required immediately.
- Shortcuts CLI fallback.

## Required Safety Rules

- Use `execFile("osascript", ["-e", script, ...args])` or equivalent safe execution.
- Never shell-interpolate note or todo content.
- Capture a real Notes HTML fixture from this machine before finalizing parser assumptions.
- Do not emit fake blank checklist items.
- Never overwrite a note that cannot be parsed into the expected section model.

## Write Flow

1. Read latest note.
2. Parse into structured sections.
3. If parse fails, ask the user and do not write.
4. Show confirmation preview for the append.
5. Immediately before write, re-read latest note.
6. Re-parse and append to the latest version.
7. If re-parse fails or section structure is ambiguous, ask instead of writing.

## Suggested Modules

```txt
src/alfred-2/notes/apple-notes.ts
src/alfred-2/notes/todo-format.ts
src/alfred-2/notes/todo-actions.ts
```

## Tests

- [ ] Safe `execFile` command shape.
- [ ] Parse canonical sections.
- [ ] Serialize round-trip for Alfred-owned canonical format.
- [ ] Append to a section while preserving existing item text/order.
- [ ] No fake blank items.
- [ ] Re-read before write.
- [ ] Refuse write when parse is ambiguous.

## Completion Criteria

- [ ] Alfred can safely append confirmed todos to `Alfred Todo`.
- [ ] Manual user edits are preserved because Phase 1 only appends.
- [ ] Ambiguous note shape results in asking, not overwriting.
