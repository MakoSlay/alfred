# 008 - Target Navigation & Focus

## Goal

Add actions to navigate between cmux targets (switch workspace, focus tab, focus pane) using existing cmux open/focus primitives, plus deterministic commands for common navigation patterns.

## Dependencies

- Requires: 001 (target resolution pattern), 002 (sidebar state for context)
- Blocks: 009, 010

## Scope

**In scope:**
- Add `focus_target` action: switches focus to a resolved target using existing cmux open/focus operations
- For workspaces: focus via opening a surface or workspace-level focus command
- For tabs/surfaces: focus via `openFile`/`openMarkdown`/`openBrowserSurface` with `focus: true` flag, or direct cmux focus command
- Add `switch_workspace` action: explicitly switch to a workspace by ref
- Add `focus_next_tab` / `focus_previous_tab` actions: cycle through tabs in current workspace
- Planner intents: `focus_target`, `switch_workspace`, `focus_next`, `focus_prev`
- Deterministic router: `"switch to Powerco"`, `"focus the main workspace"`, `"next tab"`, `"previous tab"`, `"go to the diff"`
- All focus/navigation actions are safe (no destructive effect)

**Out of scope:**
- Window management (move, resize, tile)
- Pane splitting/creation
- Tab reordering
- Keyboard shortcut customization

## Checklist

- [ ] Implement `focus_target` daemon logic: resolve target → call cmux focus/activate operation
- [ ] Implement `switch_workspace` daemon logic: resolve workspace → call cmux workspace focus
- [ ] Implement `focus_next` / `focus_prev` using cmux surface list + index tracking
- [ ] Register `cmux.focusTarget`, `cmux.switchWorkspace`, `cmux.focusNext`, `cmux.focusPrev` as safe actions
- [ ] Check if cmux adapter needs new methods (`focusTarget`, `switchWorkspace`) or if existing open*/focus flags suffice
- [ ] Add planner intents: `focus_target`, `switch_workspace`, `focus_next`, `focus_prev`
- [ ] Add planner validation: targetPhrase required for focus/switch, not for next/prev
- [ ] Add deterministic router patterns for navigation commands
- [ ] Update planner system prompt with navigation tool shapes
- [ ] Add planner unit tests for navigation intents
- [ ] Add daemon test: `focus_target` resolves and focuses a surface
- [ ] Add daemon test: `switch_workspace` switches workspace context
- [ ] Add daemon test: `focus_next` cycles to next tab; `focus_prev` cycles back
- [ ] Add daemon test: `focus_target` with ambiguous target returns clarification
- [ ] Add daemon test: `focus_target` with missing target returns clarification

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/actions.test.ts` — all pass
- [ ] Run `npm run check` — zero regressions

## Completion Criteria

- [ ] `focus_target` switches focus to the resolved target's surface/workspace
- [ ] `switch_workspace` activates a different cmux workspace
- [ ] `focus_next` and `focus_prev` cycle through tabs in the current workspace
- [ ] All navigation actions are safe (no confirmation required)
- [ ] Ambiguous/missing targets produce clarification responses
- [ ] All existing tests pass

## Notes

- cmux may not have a direct "focus workspace" command. If not, fall back to focusing the most recent surface in that workspace via `openFile`/`openBrowserSurface` with `focus: true` and the workspace ref.
- `focus_next` / `focus_prev` require tracking the current tab index within the workspace. Use `listSurfaces` to get the ordered list and track position in daemon state.
- Navigation actions are safe because they don't mutate data — they only change what the user sees.
- The cmux adapter `openFile`, `openUrl`, `openBrowserSurface`, `openMarkdown`, and `openDiff` all accept a `focus?: boolean` option. Use these as the primary focus mechanism.
