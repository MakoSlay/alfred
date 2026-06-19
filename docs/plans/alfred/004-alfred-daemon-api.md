# 004 - Alfred Daemon API

## Goal

Create the local Alfred daemon/server that exposes stable APIs for Pi, CLI, and future web UI clients.

## Scope

Implement a local-only server process in the standalone project. Prefer HTTP on localhost or a Unix socket, with contracts from Task 001. The daemon owns state; clients are thin.

## Checklist

- [ ] Add daemon entrypoint and local-only binding configuration.
- [ ] Add a local auth/guard strategy appropriate for localhost or Unix socket use, including CSRF-safe behavior for the dashboard, no permissive CORS, and DNS-rebinding-aware host/origin checks.
- [ ] Implement `POST /handle` for natural-language requests.
- [ ] Implement `GET /state` for pending drafts, active loops, recent targets, and health.
- [ ] Implement `GET /surfaces` backed by the cmux adapter.
- [ ] Implement structured daemon errors for unavailable cmux, bad input, and unsupported action.
- [ ] Ensure action endpoints enforce the capability model from the contracts task.
- [ ] Add integration tests for handle/state/surfaces using mocked adapters.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [ ] Daemon starts locally without requiring Pi.
- [ ] API responses use typed contracts.
- [ ] State is process-owned and inspectable.
- [ ] Action APIs are not exposed as an unauthenticated network control plane.
- [ ] Browser-origin, CORS, and DNS-rebinding risks are explicitly covered in implementation notes/tests.
- [ ] Validation results are recorded below.

## Notes

_To be filled during implementation._

## Validation

_To be filled during implementation._

## Blockers

_None currently._
