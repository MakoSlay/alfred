# 006 - Browser Interaction

## Goal

Implement the browser click/type/eval action handlers (currently stubs returning `"not yet implemented"`) with real cmux browser automation calls, add the temporary scoped grant system for browser mutations, and expose browser actions through the planner.

## Dependencies

- Requires: 001 (ActionHandlerContext extension pattern)
- Blocks: 009, 010

## Scope

**In scope:**
- Implement `browser.click` handler using cmux browser automation (if cmux supports it) or via keyboard injection
- Add `browser.type` restricted action with grant requirement
- Add `browser.snapshot` safe action: take a text snapshot of the current browser surface content
- Temporary grant system: one_action, time_window (e.g., 30s), this_session scopes
- Grant request flow: planner proposes browser action → daemon creates pending action with grant requirement → user confirms → grant issued → action executes → grant consumed (one_action) or remains active (time_window/session)
- Planner intents: `browser_click`, `browser_type`, `browser_snapshot`
- Deterministic router: `"click the login button"`, `"type hello in the search box"`, `"snapshot the browser"`
- Planner prompt update with browser tool shapes and grant requirement notes

**Out of scope:**
- Complex browser selectors (CSS only, no XPath)
- iframe support
- File upload dialogs
- Browser extension installation

## Checklist

- [ ] Implement `browser.click` handler: inject click event at CSS selector via cmux surface sendKey or direct browser API
- [ ] Implement `browser.type` handler: inject text at CSS selector
- [ ] Implement `browser.snapshot` handler: read browser surface text content (reuses readSurface, adds browser-specific parsing)
- [ ] Register all three browser actions with correct risk levels (click/type = restricted, snapshot = safe)
- [ ] Implement temporary grant data model and grant issuance in action registry
- [ ] Implement grant verification in `evaluatePolicy` for restricted actions
- [ ] Implement grant consumption for `one_action` scope
- [ ] Implement grant expiry for `time_window` scope
- [ ] Add planner intents: `browser_click`, `browser_type`, `browser_snapshot`
- [ ] Add planner validation: selector must be non-empty, type text must be non-empty
- [ ] Wire browser cmux methods into `ActionHandlerContext` if new cmux adapter methods are needed
- [ ] Add deterministic router patterns for browser commands
- [ ] Update planner system prompt with browser tool shapes and grant requirements
- [ ] Add planner unit tests for browser intent parsing
- [ ] Add daemon test: `browser.snapshot` executes immediately (safe)
- [ ] Add daemon test: `browser.click` creates pending action requiring grant
- [ ] Add daemon test: grant issuance and consumption flow (one_action)
- [ ] Add daemon test: grant expiry (time_window)
- [ ] Add daemon test: `browser.click` denied without valid grant

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/actions.test.ts` — all pass
- [ ] Run `npm run check` — zero regressions

## Completion Criteria

- [ ] `browser.snapshot` reads browser surface text and returns it
- [ ] `browser.click` and `browser.type` require temporary grants and create pending confirmation actions
- [ ] Grant flow works: request → confirm → grant issued → execute → grant consumed/remains
- [ ] `one_action` grants are consumed after single use
- [ ] `time_window` grants expire after the configured duration
- [ ] Browser actions are denied without valid, unexpired, scope-matching grants
- [ ] All existing tests pass

## Notes

- **Grant infrastructure is partially pre-existing.** The `TemporaryGrant` type already exists in `src/contracts/runtime.ts` and `evaluatePolicy` in the action registry already checks grants for `RESTRICTED_RISK` actions. This task extends the model with scope types (`one_action`, `time_window`, `this_session`) and implements the grant issuance flow (propose → confirm → grant → execute → consume).
- cmux browser automation capabilities depend on the installed cmux version. If cmux lacks native browser click/type, fall back to keyboard injection via `sendKeyToSurface` with tab navigation.
- CSS selectors only. Validate selector is a non-empty string. No XPath, no complex selector engines.
- `browser.snapshot` is safe because it's read-only. It reuses `readSurface` but can add browser-specific text extraction (e.g., visible text only, stripped HTML).
- Grant scopes: `one_action` (default, consumed after one use), `time_window` (expires after N ms), `this_session` (expires on daemon restart). Configurable via action proposal params.
- The existing `browser.click` stub is at `src/actions/index.ts` in `registerBuiltinActions`.
