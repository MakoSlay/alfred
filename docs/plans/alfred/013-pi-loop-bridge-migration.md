# 013 - Pi Loop Bridge Migration

## Goal

Make Pi delegate autonomous Alfred loop control to the daemon when daemon mode is enabled, while preserving Pi-local fallback when daemon mode is disabled or unavailable.

## Dependencies

- Requires: 010
- Related: 009 if loop next-actions use the daemon planner
- Blocks: None

## Scope

Move the Pi bridge/control path for delegation loops after the daemon loop manager foundation exists. This task should be small enough to review independently from daemon loop internals.

**In scope:**

- Add or update Pi bridge calls for daemon loop start, stop, and status.
- Preserve current Pi-local loop behavior when daemon mode is off.
- Fall back safely to Pi-local behavior when daemon loop APIs are unavailable or unsupported.
- Keep loop sends capability-scoped according to the daemon approval model from task 010.
- Add tests for flag-off, flag-on success, daemon-unavailable fallback, and stop behavior.

**Out of scope:**

- Redesigning daemon loop internals from task 010.
- Removing Pi-local loop code before daemon loop smoke has passed.
- Adding persistence beyond task 011's storage model.
- Dashboard polish beyond exposing existing daemon loop status.

## Checklist

- [x] Read current Pi loop paths in `/Users/muhammadabdul/work/pi-smart-voice-notify/src/index.ts` and identify the minimum bridge handoff points.
- [x] Add thin daemon-client methods for loop start, stop, and status using existing daemon bridge config and auth behavior.
- [x] Route Pi loop commands to daemon only when daemon bridge mode is explicitly enabled and the daemon reports loop support.
- [x] Preserve Pi-local loop behavior for bridge-disabled, daemon-unavailable, timeout, unsupported-response, and auth-failure cases.
- [x] Ensure Pi does not claim loop actions succeeded until the daemon response confirms the accepted state transition.
- [x] Add Pi extension tests for enabled success, disabled local fallback, daemon-unavailable fallback, unsupported loop endpoint fallback, and stop behavior.
- [x] Document live smoke and rollback steps.

## Tests

In the standalone Alfred repo if daemon loop API contracts change:

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

In the Pi extension repo:

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

Manual smoke with daemon mode enabled:

```bash
export ALFRED_DAEMON_ENABLED=true
export ALFRED_DAEMON_URL=http://127.0.0.1:47321
export ALFRED_LOCAL_TOKEN=<local-daemon-token>
```

Reload Pi and try:

```text
/alfred can you ask my power co session in this workspace to let me know what files i can delete now?
/alfred stop
```

Then disable daemon mode and verify Pi-local fallback still works.

## Completion Criteria

- [x] Pi loop commands use daemon loop APIs only when daemon bridge mode is explicitly enabled and supported.
- [x] Pi-local loop behavior remains the default and remains tested.
- [x] Daemon failure or unsupported loop response does not break `/alfred`.
- [x] Pi does not claim daemon loop state transitions until the daemon confirms them.
- [x] Live smoke and rollback findings are recorded.
- [x] Relevant gates pass in both repos if both are touched.

## Notes

- This task exists because task 010 was intentionally narrowed to daemon loop foundation work.
- Keep Pi bridge code thin. Product policy should live in Alfred daemon/core, not in the Pi extension.
- The manual smoke phrase that asks Alfred to find and manage a named session is most informative after both Task 009 (planner) and Task 010 (loop manager) are complete. Task 013 only hard-depends on Task 010 because bridge routing can still preserve fallback without planner parity.

## Implementation Notes

- Added Pi daemon-client loop helpers for `/loops/start`, `/loops/status`, `/loops/stop`, and `/loops/poll` using the existing opt-in daemon bridge config and `x-alfred-auth` token behavior.
- General `/handle` bridge calls keep draft-confirm-only capabilities; loop bridge calls use explicit loop capabilities, including `loop.autonomousSend`, so the daemon approval model remains capability-scoped.
- Pi direct loop commands and LLM-produced `delegate_loop` actions now try daemon loop start first only when daemon bridge mode is enabled and no Pi-local loop is already active. Disabled, unavailable, timeout, unsupported, and auth-failure cases fall back to the existing Pi-local loop implementation.
- Loop status/stop commands route to daemon only in daemon mode when Pi does not already own a local active loop. Semantic daemon failures are reported instead of silently claiming success; transport/unsupported/auth failures fall back to local behavior.
- Rollback remains disabling `ALFRED_DAEMON_ENABLED` / `PI_SMART_NOTIFY_ALFRED_DAEMON_ENABLED`; the Pi-local `activeDelegationLoop`, scheduler, and stop logic remain intact.

## Validation Evidence

- 2026-06-22: `/Users/muhammadabdul/work/pi-smart-voice-notify` `npm run check` — passed.
- 2026-06-22: `/Users/muhammadabdul/work/pi-smart-voice-notify` `npm run typecheck` — passed.
- 2026-06-22: `/Users/muhammadabdul/work/pi-smart-voice-notify` `npm test` — passed (71 tests).
- 2026-06-22: Cross-repo loop bridge smoke with a programmatic Alfred daemon and mock cmux target — `callAlfredDaemonLoopStart`, `callAlfredDaemonLoopStatus`, and `callAlfredDaemonLoopStop` all returned handled success.
- 2026-06-22: Live CLI daemon smoke on `ALFRED_PORT=47324` confirmed loop bridge auth/transport behavior, but full real-cmux loop start was blocked by local cmux returning `Failed to write to socket (Broken pipe, errno 32)` for `cmux workspace list --json --id-format both`. This is an environment/cmux availability issue, not a bridge-contract failure; rollback is leaving daemon bridge flags disabled.

## Blockers

_None currently; requires task 010's daemon loop API/control shape as listed above._
