# 004 - Alfred Daemon API

## Goal

Create the local Alfred daemon/server that exposes stable APIs for Pi, CLI, and future web UI clients.

## Scope

Implement a local-only server process in the standalone project. Prefer HTTP on localhost or a Unix socket, with contracts from Task 001. The daemon owns state; clients are thin.

## Checklist

- [ ] Add daemon entrypoint and local-only binding configuration.
- [ ] Implement `POST /handle` for natural-language requests.
- [ ] Implement `GET /state` for pending drafts, active loops, recent targets, and health.
- [ ] Implement `GET /surfaces` backed by the cmux adapter.
- [ ] Implement structured daemon errors for unavailable cmux, bad input, and unsupported action.
- [ ] Add integration tests for handle/state/surfaces using mocked adapters.

## Tests

```bash
cd /Users/muhammadabdul/work/cmux-operator
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [ ] Daemon starts locally without requiring Pi.
- [ ] API responses use typed contracts.
- [ ] State is process-owned and inspectable.
- [ ] Validation results are recorded below.

## Notes

_To be filled during implementation._

## Validation

_To be filled during implementation._

## Blockers

_None currently._
