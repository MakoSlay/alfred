# Alfred

Alfred is a local, cmux-backed personal assistant that can observe, coordinate, and safely command Pi, Codex, shells, and other terminal agents or processes running inside cmux.

This project is intentionally separate from `pi-smart-voice-notify`. The current Pi extension remains the live/default `/alfred` implementation while Alfred is built in parallel, but the long-term goal is for Alfred to own its runtime and use Pi as one target/interface rather than living inside Pi.

## Plan

See:

```text
docs/plans/alfred/PLAN.md
```

## Initial Goal

Build a local runtime/daemon that uses cmux as the workspace/surface substrate, then expose it through `/alfred` in Pi, CLI, web UI, and eventually non-Pi voice/input surfaces.

## Development

The current Pi extension remains the live/default `/alfred` path while this repo is built in parallel.

```bash
npm install
npm run check
npm run typecheck
npm test
```

Start the local daemon:

```bash
ALFRED_LOCAL_TOKEN=dev-local-token npm run daemon
```

By default Alfred binds `127.0.0.1:47321` and serves the dashboard at:

```text
http://127.0.0.1:47321/dashboard
```

Daemon env config:

- `ALFRED_HOST` — loopback bind host (`127.0.0.1`, `localhost`, or `::1`), default `127.0.0.1`.
- `ALFRED_PORT` — bind port, default `47321`.
- `ALFRED_LOCAL_TOKEN` — local auth token for authenticated API calls.

If `ALFRED_LOCAL_TOKEN` is not set, the daemon generates a process-local token, prints it once for the local operator, and does not persist it. The dashboard URL intentionally does not include tokens.

Smoke commands:

```bash
curl -s http://127.0.0.1:47321/health
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/state
curl -s -H 'x-alfred-auth: dev-local-token' http://127.0.0.1:47321/surfaces
```

Initial source layout:

```text
src/contracts/   Shared request/response/action/event contracts
src/core/        Alfred core runtime placeholder
src/cmux/        cmux world-model adapter placeholder
src/daemon/      daemon/server placeholder
src/cli/         CLI source placeholder
src/web/         web/dashboard source placeholder
src/testing/     contract fixtures and test helpers
```
