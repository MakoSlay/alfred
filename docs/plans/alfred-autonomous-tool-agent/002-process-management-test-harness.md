# 002 - Process Management & Test Harness

## Goal

Fix Alfred process hygiene and create a test harness before changing the agent loop, so development is repeatable and safe.

## Dependencies

- Requires: 001
- Blocks: 003, 009

## Scope

**In scope:**
- Add PID file management on startup/shutdown.
- Add `npm run alfred2:stop` and optional restart script.
- Add request IDs and basic trace IDs.
- Add fake LLM/test harness support so agent-loop tests do not call DeepSeek.
- Add a thin LLM client interface that returns text plus usage metadata when available.
- Add observability: timing, tool count, retries, token usage estimate/provider usage, session id, request id, and failure reason.

**Out of scope:**
- Real background task queue.
- Subagents/intercom.
- Dashboard UI.
- Long-running autonomous workers.

## Checklist

- [x] Add PID file path under `~/.alfred/alfred2.pid`.
- [x] On startup, detect existing PID; kill stale process or fail clearly if active.
- [x] Clean PID file on shutdown and signal handling.
- [x] Add `alfred2:stop` script to `package.json`.
- [x] Introduce request IDs in `/ask` responses, logs, and history.
- [x] Add an injectable LLM client/fake response sequence for tests.
- [x] Ensure fake LLM responses can include token usage metadata for session-accounting tests.
- [x] Confirm new tests live in `test/*.test.ts` unless `package.json` test script is intentionally updated.

## Tests

- [x] Add test or script verification for PID stale/active behavior where feasible.
- [x] Add test: fake LLM sequence can drive an agent/tool-loop unit test without network.
- [x] Add test: provider-reported token usage is captured when present and estimated when absent.
- [ ] Manual: start, stop, restart Alfred repeatedly; no port zombie remains.
- [x] Run `npm run check`.

## Completion Criteria

- [x] Multiple Alfred processes no longer accumulate.
- [x] Agent-loop work can be tested without real LLM calls.
- [x] Request traces make debugging failures straightforward.
- [x] LLM usage metadata is available to later session handoff logic.

## Notes

- This moved earlier because zombie processes and unmocked LLM calls will slow every later task.
