# 007 - Testing, Migrate & Ship

## Goal

Comprehensive testing of the full Alfred 2.0 pipeline, ensure coexistence with Alfred 1.x, write migration docs, and ship.

## Dependencies

- Requires: 001, 002, 003, 004, 005, 006
- Blocks: None (final task)

## Scope

**In scope:**
- End-to-end tests: voice text → context → agent → command → execution → speech
- Test with real LLM (not mocked): verify the agent actually uses pre-injected context
- Test with mocked LLM: verify pipeline correctness without API costs
- Coexistence tests: Alfred 1.x daemon runs, Alfred 2.0 extension runs, both handle `/alfred` correctly
- Regression tests: Alfred 1.x daemon tests still pass (167 tests baseline)
- Pi integration test: load extension in pi, run `/alfred` commands, verify speech output
- Migration guide: document how to switch between Alfred 1.x and 2.0
- Env var reference: document all configuration options
- Ship: update `pi-smart-voice-notify` extension or create new extension

**Out of scope:**
- Removing Alfred 1.x (keep it for dashboard/cmux-surface features)
- Pi package distribution
- Automated deployment

## Checklist

- [ ] Write end-to-end test: mock LLM returns `{ speech: "Opening Chrome.", command: "open -a 'Google Chrome'" }` → verify extension executes command and speaks
- [ ] Write end-to-end test: mock LLM returns speech-only → verify extension speaks without executing
- [ ] Write end-to-end test: destructive command → confirmation prompt → user confirms → executes
- [ ] Write end-to-end test: destructive command → confirmation prompt → user denies → aborts
- [ ] Write end-to-end test: mute → speech suppressed → unmute → speech restored
- [ ] Write end-to-end test: context pre-injection includes all workspaces → agent answers without discovery commands
- [ ] Write test: Alfred 1.x daemon tests still pass (run `npm run check` from repo root)
- [ ] Write test: Alfred 2.0 extension loads without breaking pi
- [ ] Write test: `/alfred` with 2.0 disabled falls back to 1.x daemon
- [ ] Write migration doc: `docs/alfred-2-migration.md` — how to enable 2.0, env vars, differences from 1.x
- [ ] Write env var reference: all `ALFRED_2_*` and `ALFRED_LLM_*` variables documented
- [ ] Update `pi-smart-voice-notify` extension to support Alfred 2.0 (or create new `pi-alfred-2` extension)
- [ ] Manual integration test: load extension in pi, run 5 different `/alfred` commands, verify all work
- [ ] Manual coexistence test: Alfred 1.x daemon running, Alfred 2.0 extension loaded, `/alfred` routes to 2.0, dashboard still works
- [ ] Performance test: context gathering < 2s, agent response < 5s (with real LLM), total latency < 7s

## Tests

- [ ] Run `node --test --experimental-strip-types test/alfred-2/` — all test files pass
- [ ] Run `npm run check` from repo root — 167+ tests pass, zero regressions
- [ ] Manual pi smoke: `/alfred open Chrome`, `/alfred what's in sandbox`, `/alfred mute for 1 min`

## Completion Criteria

- [ ] Full pipeline works: voice text → context → agent → execute → speak
- [ ] Confirmation guard works for destructive commands
- [ ] Mute works as in Alfred 1.x
- [ ] Token report shows savings from context pre-injection
- [ ] Alfred 1.x daemon continues to work alongside 2.0
- [ ] All tests pass, zero regressions
- [ ] Migration docs are clear and complete
- [ ] Extension is installable and works in pi

## Notes

- Alfred 1.x and 2.0 solve different problems. 1.x is for dashboard/cmux-surface interaction with structured actions. 2.0 is for voice-first natural language control. They can and should coexist.
- The migration doc should make clear: if you want voice control, use 2.0. If you want the dashboard or cmux-surface features, use 1.x. Both can run simultaneously.
- The extension name `pi-alfred-2` is proposed. It can live alongside the existing `pi-smart-voice-notify` extension. Users enable one or both.
