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

- [ ] Read current Pi loop paths in `/Users/muhammadabdul/work/pi-smart-voice-notify/src/index.ts` and identify the minimum bridge handoff points.
- [ ] Add thin daemon-client methods for loop start, stop, and status using existing daemon bridge config and auth behavior.
- [ ] Route Pi loop commands to daemon only when daemon bridge mode is explicitly enabled and the daemon reports loop support.
- [ ] Preserve Pi-local loop behavior for bridge-disabled, daemon-unavailable, timeout, unsupported-response, and auth-failure cases.
- [ ] Ensure Pi does not claim loop actions succeeded until the daemon response confirms the accepted state transition.
- [ ] Add Pi extension tests for enabled success, disabled local fallback, daemon-unavailable fallback, unsupported loop endpoint fallback, and stop behavior.
- [ ] Document live smoke and rollback steps.

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

- [ ] Pi loop commands use daemon loop APIs only when daemon bridge mode is explicitly enabled and supported.
- [ ] Pi-local loop behavior remains the default and remains tested.
- [ ] Daemon failure or unsupported loop response does not break `/alfred`.
- [ ] Pi does not claim daemon loop state transitions until the daemon confirms them.
- [ ] Live smoke and rollback findings are recorded.
- [ ] Relevant gates pass in both repos if both are touched.

## Notes

- This task exists because task 010 was intentionally narrowed to daemon loop foundation work.
- Keep Pi bridge code thin. Product policy should live in Alfred daemon/core, not in the Pi extension.

## Blockers

- Requires task 010's daemon loop API/control shape.
