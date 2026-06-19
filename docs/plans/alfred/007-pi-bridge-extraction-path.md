# 007 - Pi Bridge and Extraction Path

## Goal

Allow the existing Pi `/alfred` command to optionally call the new Alfred daemon while preserving current Pi-local behavior and establishing a path for Alfred to eventually run independently of the Pi extension.

## Scope

Modify `pi-smart-voice-notify` only after the standalone daemon supports handle/state/confirm flows. The bridge must be opt-in and safe to disable instantly. This task should not remove Pi support; it should make Pi one Alfred client/target among others.

## Checklist

- [x] Add feature flag/config for server-backed Alfred mode.
- [x] Implement a thin client from the Pi extension to the daemon.
- [x] Preserve existing in-extension Alfred behavior when the flag is off.
- [x] Fall back to existing behavior when the daemon is unavailable or returns an unsupported response.
- [x] Keep the daemon contract independent of Pi-only concepts so CLI/web/future voice clients can call it too.
- [x] Add tests for flag-off, flag-on success, daemon-unavailable fallback, and daemon contract portability.
- [x] Document reload, smoke-test, and rollback steps for live Pi validation.

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

- [x] Server-backed mode is opt-in only.
- [x] Existing Pi-local behavior remains default and tested.
- [x] Daemon failure does not break `/alfred`.
- [x] The bridge moves Alfred toward daemon ownership rather than deeper Pi-extension coupling.
- [x] Validation results are recorded below.

## Notes

Implemented the optional Pi bridge in `/Users/muhammadabdul/work/pi-smart-voice-notify` and committed it there as:

```text
b721732 Add optional Alfred daemon bridge
```

Bridge behavior:

- New thin client module: `src/alfred-adapters/daemon-client.ts`.
- New tests: `src/alfred-adapters/__tests__/daemon-client.test.ts`.
- `/alfred` remains Pi-local by default. The bridge is disabled unless one of these env flags is truthy:
  - `PI_SMART_NOTIFY_ALFRED_DAEMON_ENABLED`
  - `ALFRED_DAEMON_ENABLED`
- Daemon endpoint/token/timeout are configurable through env:
  - `PI_SMART_NOTIFY_ALFRED_DAEMON_URL` or `ALFRED_DAEMON_URL` (default `http://127.0.0.1:47321`)
  - `PI_SMART_NOTIFY_ALFRED_DAEMON_TOKEN`, `ALFRED_DAEMON_TOKEN`, or `ALFRED_LOCAL_TOKEN`
  - `PI_SMART_NOTIFY_ALFRED_DAEMON_TIMEOUT_MS` or `ALFRED_DAEMON_TIMEOUT_MS` (default `2000`)
- When enabled, `/alfred` posts a portable `AlfredHandleRequest` to daemon `POST /handle` with source kind `pi-command` and shared capabilities.
- If the daemon returns a displayable response, Pi speaks/notifies that response and does not run the local core path.
- If the daemon is disabled, unavailable, times out, returns non-JSON, returns no displayable message, or reports unsupported handle route, Pi falls back to the existing in-extension Alfred behavior.
- Existing direct Pi delegation-loop shortcuts still run locally before daemon bridge handoff because loop ownership is not fully extracted yet.

Reload/smoke-test steps for live Pi validation:

1. Start the standalone Alfred daemon locally and note its token.
2. Export bridge env before launching/reloading Pi:
   ```bash
   export ALFRED_DAEMON_ENABLED=true
   export ALFRED_DAEMON_URL=http://127.0.0.1:47321
   export ALFRED_LOCAL_TOKEN=<local-daemon-token>
   ```
3. Reload the Pi extension/session.
4. Smoke-test:
   ```text
   /alfred tell this chat hello from server-backed Alfred
   /alfred send that
   /alfred can you ask my power co session in this workspace to let me know what files i can delete now?
   ```
5. Rollback instantly by unsetting `ALFRED_DAEMON_ENABLED` or setting it to `false`, then reload. With the flag off, `/alfred` uses the existing Pi-local path.

## Validation

Standalone Alfred repo:

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

All passed after Task 006; Task 007 only updates plan docs in the standalone repo.

Pi extension repo:

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

All passed. `npm test` ran 65 tests, including the new daemon bridge client tests.

Existing uncommitted Pi extension changes that predated this task were not staged in the bridge commit.

## Blockers

_None currently._
