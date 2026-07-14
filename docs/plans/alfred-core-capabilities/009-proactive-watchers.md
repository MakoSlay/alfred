# 009 - Proactive Watchers & Monitoring

## Goal

Connect the loop manager to the action registry so watchers can poll targets, read surface content, run planner decisions, and notify the user — making Alfred proactive rather than purely reactive.

## Dependencies

- Requires: 001 (read surface), 002 (sidebar state), 003 (notification management), 004 (conversation memory context for watcher decisions), 005 (chains for watcher actions), 006 (browser interaction for browser watchers), 007 (shell execution for command watchers), 008 (target navigation for watcher focus)
- Blocks: 010

## Scope

**In scope:**
- Connect `loop.start` action handler to `AlfredLoopManager` (currently returns `"not yet connected"`)
- Implement watcher poll pipeline: read surface → decide (LLM or rule) → if action needed → propose pending action or notify
- Add `watcher.start` intent with goal, target, poll interval, autoSend permission flag
- Add `watcher.stop` intent
- Add `watcher.status` intent
- Add `watcher.list` intent
- Watcher decision modes: `llm` (planner decides each poll), `rule` (simple condition like "file changed" or "test failed"), `notification` (alert on any new cmux notification)
- Watcher notification: when watcher detects something, push a cmux notification and/or create a pending action
- Auto-send: watchers can auto-send messages only with explicit user permission per watcher
- Watcher lifecycle persistence: watchers survive poll cycles but clear on daemon restart
- Planner prompt update with watcher tool shapes

**Out of scope:**
- Persistent watchers across daemon restarts
- Complex event correlation across multiple targets
- Watcher templates/recipes (already scoped in original roadmap Task 009)
- External webhook/API watchers

## Checklist

- [ ] Connect `loop.start` action handler to `AlfredLoopManager.start()`
- [ ] Implement watcher poll pipeline: read target surface → call decide function → process decision
- [ ] Implement LLM decide mode: send surface text + goal to planner → interpret intent → execute
- [ ] Implement rule decide mode: check simple conditions (text changed, keyword found, test output pattern)
- [ ] Implement notification decide mode: poll cmux notifications, alert on new unread
- [ ] Register `watcher.start` as confirmation_required action (requires `loop.manage` capability)
- [ ] Register `watcher.stop`, `watcher.status`, `watcher.list` as safe actions
- [ ] Add `watcher_start`, `watcher_stop`, `watcher_status`, `watcher_list` to `AlfredPlannerIntent`
- [ ] Add watcher auto-send permission flag and enforcement
- [ ] Add watcher notification push: use `cmux.log` or `cmux.setStatus` to surface watcher findings
- [ ] Add deterministic router patterns: `"watch the Powerco tab"`, `"monitor for changes"`, `"stop watching"`, `"what are you watching"`
- [ ] Update planner system prompt with watcher tool shapes
- [ ] Add planner unit tests for watcher intents
- [ ] Add daemon test: `watcher.start` creates active watcher with poll interval
- [ ] Add daemon test: watcher poll reads surface and executes decision
- [ ] Add daemon test: `watcher.stop` stops active watcher
- [ ] Add daemon test: `watcher.status` returns current watcher info
- [ ] Add daemon test: `watcher.list` returns all active watchers
- [ ] Add daemon test: watcher auto-send denied without explicit permission
- [ ] Add daemon test: watcher clears on daemon restart

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/actions.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/loops.test.ts` — all pass (update existing)
- [ ] Run `npm run check` — zero regressions

## Completion Criteria

- [ ] `loop.start` through the action registry actually starts a watcher (no longer returns `"not yet connected"`)
- [ ] Watchers poll targets on the configured interval and run decisions
- [ ] LLM-mode watchers read surface content and use the planner to decide actions
- [ ] Rule-mode watchers detect simple conditions (text changed, keyword match)
- [ ] Notification-mode watchers alert on new unread cmux notifications
- [ ] Watchers push findings as cmux sidebar log entries or pending actions
- [ ] Auto-send is denied unless explicitly permitted per watcher
- [ ] `watcher.stop` cleanly stops polling
- [ ] `watcher.status` and `watcher.list` show active watchers
- [ ] Watchers clear on daemon restart (no stale state)
- [ ] All existing tests pass

## Notes

- The loop manager infrastructure already exists at `src/loops/index.ts` with `AlfredLoopManager`, `AlfredLoopRuntimeState`, and polling logic. The gap is the connection between `loop.start` action handler and the loop manager instance.
- Architectural challenge: `loop.start` is registered in `registerBuiltinActions()` which receives an `ActionRegistry`, not the `AlfredLoopManager`. The daemon creates both, but the action handler's `ActionHandlerContext` doesn't include the loop manager. Solution options: (A) extend `ActionHandlerContext` with `loopManager`, (B) use a closure in `registerBuiltinActions` that captures the loop manager, (C) have the daemon intercept `loop.start` proposals before they reach the generic action registry. Option A is cleanest and consistent with how `cmux` is already in the context.
- Watcher poll interval should be configurable (default 10s, min 2s, max 300s). Too-frequent polling could overload cmux.
- LLM decide mode reuses the planner endpoint. Each poll is a separate LLM call — watchers with short intervals will consume LLM resources. Warn if interval < 30s with LLM mode.
- `AlfredLoopDecision` already supports `kind: "done" | "needs_user" | "continue" | "execute"`. The `execute` kind should map to creating a pending action through the action registry.
- The original roadmap Task 010 (`010-proactive-monitoring-recipes.md`) covers watcher recipe templates. This task covers the execution engine. The recipe system builds on top of this.
