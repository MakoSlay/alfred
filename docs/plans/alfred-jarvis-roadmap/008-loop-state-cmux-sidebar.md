# 008 - Loop State in Cmux Sidebar

## Goal

Publish Alfred daemon loop state to cmux sidebar status, progress, and logs so active work is visible in the native cockpit.

## Dependencies

- Requires: 001, 002
- Blocks: 009, 010, 011, 013

## Scope

**In scope:**
- Map loop and watcher lifecycle events to cmux sidebar primitives: `set-status`, `set-progress`, `clear-progress`, `log`, `list-status`, and `sidebar-state`.
- Show loop/watcher owner, goal, state, last event, pending confirmation, next run time, and failure summary where appropriate.
- Keep the Alfred dashboard and cmux sidebar consistent.
- Treat Alfred sidebar status/progress/log writes as safe local UI updates that do not require confirmation.

**Out of scope:**
- Implementing new watcher/recipe logic.
- Replacing the dashboard loop panel.

## Checklist

- [ ] Define loop-to-sidebar state mapping for idle, running, waiting, needs-approval, failed, and stopped states.
- [ ] Use existing adapter methods for status, progress, log, and sidebar-state commands; add `clear-progress` and `list-status` adapter methods if needed by the loop publication design.
- [ ] Emit sidebar updates from the daemon loop manager without blocking loop execution on cmux failures.
- [ ] Add dashboard display for latest sidebar publication status and errors.
- [ ] Add cleanup behavior for stopped loops and daemon shutdown.
- [ ] Document how loop state appears in cmux and how to clear stale state.

## Tests

- [ ] Run `npm run typecheck` and verify loop/sidebar contracts compile.
- [ ] Run `npm test` and verify sidebar calls for loop lifecycle transitions and cmux failure fallback.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA inside cmux: start a delegated loop and verify status/progress/log entries appear in the cmux sidebar.

## Completion Criteria

- [ ] Active Alfred loops publish useful status to cmux sidebar primitives.
- [ ] cmux sidebar failures do not crash or stall daemon loops.
- [ ] Stopped or completed loops clear or finalize sidebar state predictably.

## Notes

- cmux already has the sidebar UI; Alfred should write high-signal state into it.
- `sidebar-state` output is key/value text on current cmux, so parsing must be tolerant of new keys and missing fields.
- Sidebar writes here mean Alfred-owned status/progress/log telemetry, not arbitrary destructive workspace operations.
