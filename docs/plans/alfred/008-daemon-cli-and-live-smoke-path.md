# 008 - Daemon CLI and Live Smoke Path

## Goal

Make Alfred startable as a real local daemon from the standalone repo and document the first live Pi bridge smoke path.

## Dependencies

- Requires: 004, 005, 006, 007
- Blocks: 009, 010, 011, 012

## Scope

Add the smallest polished daemon entrypoint needed for local use. This task should not change Pi's default `/alfred` behavior and should not expand daemon planning beyond the existing deterministic draft-confirm flow.

**In scope:**

- `npm run daemon` and/or an `alfred daemon`-style source entrypoint.
- Env-driven daemon config for host, port, and token.
- Startup/shutdown operator output that is useful but secret-safe.
- Curl/manual smoke docs for daemon API and dashboard.
- Pi bridge live smoke procedure using the existing opt-in bridge, with unsupported planner-dependent behavior recorded as findings rather than treated as a hard failure before task 009.

**Out of scope:**

- LLM planner parity with Pi-local Alfred.
- Daemon-owned autonomous loops.
- Persistent storage.
- Dashboard redesign beyond what is needed to smoke the daemon.

## Checklist

- [x] Add a daemon CLI entrypoint such as `src/cli/daemon.ts` that creates and starts `createAlfredDaemon()`.
- [x] Add a package script such as `"daemon": "node --experimental-strip-types src/cli/daemon.ts"`.
- [x] Read `ALFRED_HOST`, `ALFRED_PORT`, and `ALFRED_LOCAL_TOKEN` from env, with safe defaults matching `defaultDaemonConfig()`.
- [x] Validate `ALFRED_PORT` and fail clearly for invalid values.
- [x] Print bind host/port, dashboard URL, token source/generation status, and shutdown instructions.
- [x] Avoid printing existing user-provided tokens by default; if a token is generated, print it once for the local operator and never persist it.
- [x] Do not include the token in the dashboard URL or other copy-pastable URLs by default.
- [x] Handle startup failures such as `EADDRINUSE` with a clear message and nonzero exit.
- [x] Handle `SIGINT`/`SIGTERM` by stopping the daemon cleanly.
- [x] Add tests or a no-network unit seam for env parsing, startup message behavior, generated-token messaging, invalid port handling, and configured-token redaction.
- [x] Document curl smoke and Pi bridge reload/smoke steps in this task or README.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

Manual daemon smoke after implementation:

```bash
cd /Users/muhammadabdul/work/alfred
ALFRED_LOCAL_TOKEN=dev-local-token npm run daemon
```

In another shell:

```bash
curl -s http://127.0.0.1:47321/health
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/state
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/surfaces
```

Optional live Pi bridge smoke after daemon is running. Record actual results; before task 009, planner-dependent phrasing may fall back to Pi-local behavior or produce a deterministic daemon response rather than full Pi-local LLM parity:

```bash
export ALFRED_DAEMON_ENABLED=true
export ALFRED_DAEMON_URL=http://127.0.0.1:47321
export ALFRED_LOCAL_TOKEN=dev-local-token
```

Reload Pi and try:

```text
/alfred tell this chat hello from server-backed Alfred
/alfred send that
/alfred can you ask my power co session in this workspace to let me know what files i can delete now?
```

## Implementation Notes

- Added `src/cli/daemon.ts` with no-network testable seams for env parsing, startup message formatting, startup error formatting, and `runDaemonCli()`.
- Added `npm run daemon` as `node --experimental-strip-types src/cli/daemon.ts`.
- Added `test/cli.test.ts` coverage for defaults, env overrides, invalid ports, generated-token output, configured-token redaction, bind-in-use messaging, and startup failure exit behavior.
- Updated `README.md` with daemon env config and curl smoke commands.

## Live Smoke Findings

Run from `/Users/muhammadabdul/work/alfred` after implementation.

Configured-token daemon start:

```bash
ALFRED_LOCAL_TOKEN=dev-local-token npm run daemon
```

Startup output included:

```text
Listening: http://127.0.0.1:47321
Dashboard: http://127.0.0.1:47321/dashboard
Auth token: using ALFRED_LOCAL_TOKEN from the environment; value is not printed.
Use API header: x-alfred-auth: <your ALFRED_LOCAL_TOKEN>
Shutdown: press Ctrl+C or send SIGTERM.
Alfred daemon ready on http://127.0.0.1:47321
```

Curl smoke results:

```bash
curl -s http://127.0.0.1:47321/health
# {"ok":true,"health":"ok"}

curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/state
# {"health":"ok","pendingDrafts":[],"activeLoop":null,"recentTargets":[],"events":[]}

curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/surfaces
# Returned {"ok":true,"targets":[...]} with current cmux workspaces and surfaces.
```

Dashboard smoke:

```bash
open http://127.0.0.1:47321/dashboard
```

Result: `open` exited successfully, and `curl -s http://127.0.0.1:47321/dashboard` returned the Alfred Local Dashboard HTML. The dashboard URL contained no token.

Generated-token smoke:

```bash
env -u ALFRED_LOCAL_TOKEN ALFRED_PORT=47323 npm run daemon
```

Result: daemon generated a process-local token, printed the generated token once, used `x-alfred-auth: <generated token above>` for instructions, did not persist the token, and shut down cleanly on `SIGTERM`.

Invalid-port smoke:

```bash
ALFRED_PORT=not-a-number npm run daemon
# exit=1
# Invalid ALFRED_PORT "not-a-number": expected an integer between 1 and 65535.
```

Alternate-port smoke:

```bash
ALFRED_PORT=47322 ALFRED_LOCAL_TOKEN=dev-local-token npm run daemon
curl -s http://127.0.0.1:47322/health
# {"ok":true,"health":"ok"}
```

Bind-in-use smoke:

```bash
ALFRED_LOCAL_TOKEN=dev-local-token npm run daemon
# while another daemon already owned 127.0.0.1:47321
# exit=1
# Failed to start Alfred daemon: 127.0.0.1:47321 is already in use. Set ALFRED_PORT to a free local port or stop the existing daemon.
```

Shutdown smoke:

```bash
kill -TERM <daemon-pid>
```

Result: daemon printed `Received SIGTERM; stopping Alfred daemon...` followed by `Alfred daemon stopped.` and exited `0`.

Optional Pi bridge smoke status:

- Procedure remains documented below and uses the existing opt-in env gate.
- Not run in this pass because Task 008 did not touch the Pi extension and live Pi reload is operator/session-dependent.
- Pi default remains daemon-disabled unless `ALFRED_DAEMON_ENABLED=true` is set.

## Validation

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
```

Result: passed. `npm run check` ran TypeScript typecheck and 27 Node tests, including 8 CLI-focused tests in `test/cli.test.ts`.

Pi extension gates were not run because Task 008 did not modify `/Users/muhammadabdul/work/pi-smart-voice-notify`.

## Completion Criteria

- [x] `npm run daemon` starts Alfred on `127.0.0.1:47321` by default or on configured host/port.
- [x] Startup output includes dashboard URL and token instructions without unsafe secret leakage, and the dashboard URL does not include the token by default.
- [x] Authenticated daemon APIs work with the configured token.
- [x] Invalid port and bind-in-use failures are handled clearly without hanging.
- [x] Manual curl smoke steps are recorded with results.
- [x] Pi bridge smoke procedure is documented, records actual findings, and does not require daemon by default.
- [x] Standalone Alfred gates pass.

## Notes

- Preserve direct `/send` as unsupported; use draft creation followed by `/confirm` or `send that`.
- Browser-reachable localhost is not a trust boundary. Keep existing host/origin/token checks intact.
- Do not commit local tokens or transcripts.

## Blockers

_None currently._
