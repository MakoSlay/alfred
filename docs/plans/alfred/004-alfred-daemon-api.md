# 004 - Alfred Daemon API

## Goal

Create the local Alfred daemon/server that exposes stable APIs for Pi, CLI, and future web UI clients.

## Scope

Implement a local-only server process in the standalone project. Prefer HTTP on localhost or a Unix socket, with contracts from Task 001. The daemon owns state; clients are thin.

## Checklist

- [x] Add daemon entrypoint and local-only binding configuration.
- [x] Add a local auth/guard strategy appropriate for localhost or Unix socket use, including CSRF-safe behavior for the dashboard, no permissive CORS, and DNS-rebinding-aware host/origin checks.
- [x] Implement `POST /handle` for natural-language requests.
- [x] Implement `GET /state` for pending drafts, active loops, recent targets, and health.
- [x] Implement `GET /surfaces` backed by the cmux adapter.
- [x] Implement structured daemon errors for unavailable cmux, bad input, and unsupported action.
- [x] Ensure action endpoints enforce the capability model from the contracts task.
- [x] Add integration tests for handle/state/surfaces using mocked adapters.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [x] Daemon starts locally without requiring Pi.
- [x] API responses use typed contracts.
- [x] State is process-owned and inspectable.
- [x] Action APIs are not exposed as an unauthenticated network control plane.
- [x] Browser-origin, CORS, and DNS-rebinding risks are explicitly covered in implementation notes/tests.
- [x] Validation results are recorded below.

## Notes

Implemented the initial local daemon in `src/daemon/index.ts`.

Key behavior:

- `createAlfredDaemon()` starts a Node HTTP server bound by default to `127.0.0.1` with a generated or configured local auth token.
- `defaultDaemonConfig()` centralizes local host, port, auth token, host allowlist, origin allowlist, and max JSON body size.
- All non-health routes require `x-alfred-auth` or `Authorization: Bearer <token>`.
- DNS-rebinding-aware `Host` checks allow only configured local hosts.
- Browser-style `Origin` checks reject untrusted origins.
- `OPTIONS` preflight is forbidden and responses do not emit permissive CORS headers.
- `POST /handle` accepts an `AlfredHandleRequest`, validates input and `world.read`, records a process-owned `request.received` event, and returns an `AlfredHandleResponse`. Privileged action planning/execution is intentionally reserved for Task 005.
- `GET /state` returns process-owned health, pending-draft placeholder, loop placeholder, recent targets, and event history.
- `GET /surfaces` uses the cmux adapter dependency and returns structured `cmux_unavailable` errors on adapter failure.
- Reserved action routes (`/confirm`, `/cancel`, `/send`) are authenticated first and then return structured unsupported-action errors until Task 005 enables execution.

Tests in `test/daemon.test.ts` cover local auth, state, surfaces with a mocked cmux adapter, typed `/handle` responses and persisted events, bad JSON, cmux failure, DNS rebinding host rejection, origin rejection, and absence of permissive CORS headers.

## Validation

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

All passed. `npm test` ran 12 Node test cases total, including 5 daemon integration tests.

The Pi extension repo was not modified, so Pi extension gates were not required.

## Blockers

_None currently._
