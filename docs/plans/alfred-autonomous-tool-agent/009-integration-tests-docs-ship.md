# 009 - Integration Tests, Docs, and Ship

## Goal

Verify the full Alfred autonomous tool-agent stack end to end and document how to use, configure, and extend it.

## Dependencies

- Requires: 001, 002, 003, 004, 005, 006, 007, 008
- Blocks: None

## Scope

**In scope:**
- End-to-end tests for multi-tool voice workflows.
- Documentation for env vars, tool behavior, execution context/cwd selection, display surfaces, safety model, provider setup, and examples.
- Regression checks for Alfred 1.x and Alfred 2.0 existing behavior.
- Manual QA scripts for Wispr Flow, web search, file edit, CI, mute/history.
- Session-continuity audit: token tracking, 80k warning behavior, 100k handoff generation, and fresh-session continuation.

**Out of scope:**
- New features beyond the prior tasks.
- Dashboard restoration.
- Subagents/intercom.

## Checklist

- [x] Add integration test: web search → final speech with mocked provider.
- [x] Add integration test: read file → edit file → run test command on a scratch fixture.
- [x] Add integration test: CI status → failed log summary with mocked `gh`.
- [x] Add integration test: failed command → retry alternative → final speech.
- [x] Add integration test: dangerous command → pending confirmation → exact payload execution.
- [x] Add integration test: session reaches 100k token threshold → deterministic handoff is generated and future request can continue from it.
- [x] Update README/docs with examples, env vars, Exa setup, handoff file location, workspace alias config, display surface behavior, and personal-local scope.
- [x] Document how to add future tools, including subagents later, without changing the tool loop.
- [x] Run direct cmux execution guard and document expected result.
- [x] Run full manual smoke matrix from the handoff.

## Tests

- [x] Run `npm run check`.
- [x] Manual: `Alfred search the web for ...`.
- [x] Manual: `Alfred read package.json and update ...` on a safe scratch file first.
- [x] Manual: `Alfred are my CI checks passing?`.
- [x] Manual: Wispr Flow wake word still triggers `/ask`.
- [x] Manual: mute/history still work.
- [x] Manual: repeated start/stop does not leave stale processes.

## Completion Criteria

- [x] All automated tests pass.
- [x] Manual smoke tests pass.
- [x] Documentation explains config, safety, tool authoring, session handoff, cmux context model, implementation defaults, and future autonomy extension points.
- [x] Alfred remains concise and butler-like in speech despite richer tool use.
- [x] Alfred reliably generates a handoff before/at 100k session tokens and can continue from it in a fresh session.

## Notes

- This final pass should use the dev-workflow habit: plan review, self-review, standards pass, CI/checks, docs, then ship.
