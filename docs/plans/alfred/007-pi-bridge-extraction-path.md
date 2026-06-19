# 007 - Pi Bridge and Extraction Path

## Goal

Allow the existing Pi `/alfred` command to optionally call the new Alfred daemon while preserving current Pi-local behavior and establishing a path for Alfred to eventually run independently of the Pi extension.

## Scope

Modify `pi-smart-voice-notify` only after the standalone daemon supports handle/state/confirm flows. The bridge must be opt-in and safe to disable instantly. This task should not remove Pi support; it should make Pi one Alfred client/target among others.

## Checklist

- [ ] Add feature flag/config for server-backed Alfred mode.
- [ ] Implement a thin client from the Pi extension to the daemon.
- [ ] Preserve existing in-extension Alfred behavior when the flag is off.
- [ ] Fall back to existing behavior when the daemon is unavailable or returns an unsupported response.
- [ ] Keep the daemon contract independent of Pi-only concepts so CLI/web/future voice clients can call it too.
- [ ] Add tests for flag-off, flag-on success, daemon-unavailable fallback, and daemon contract portability.
- [ ] Document reload, smoke-test, and rollback steps for live Pi validation.

## Tests

In the standalone project:

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

In the current Pi extension repo:

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

Optional live smoke after sync/reload:

```text
/alfred tell this chat hello from server-backed Alfred
/alfred send that
/alfred can you ask my power co session in this workspace to let me know what files i can delete now?
```

## Completion Criteria

- [ ] Server-backed mode is opt-in only.
- [ ] Existing Pi-local behavior remains default and tested.
- [ ] Daemon failure does not break `/alfred`.
- [ ] The bridge moves Alfred toward daemon ownership rather than deeper Pi-extension coupling.
- [ ] Validation results are recorded below.

## Notes

_To be filled during implementation._

## Validation

_To be filled during implementation._

## Blockers

_None currently._
