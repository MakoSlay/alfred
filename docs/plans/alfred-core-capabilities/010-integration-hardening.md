# 010 - Integration, Planner Prompt & Hardening

## Goal

Wire all nine preceding tasks together: update the planner system prompt with the complete tool inventory, add end-to-end integration tests for the full capability stack, ensure deterministic routing covers all new actions, harden error/edge cases, and verify no regressions.

## Dependencies

- Requires: 001, 002, 003, 004, 005, 006, 007, 008, 009
- Blocks: None (final task)

## Scope

**In scope:**
- Full planner system prompt rewrite: include all tool shapes from tasks 001-009
- Planner prompt examples: show multi-step chain, summarize workflow, watcher setup
- Deterministic router coverage audit: every new action must have at least one deterministic pattern
- End-to-end integration tests: read → summarize → draft chain, watcher lifecycle, notification management flow
- Error hardening: LLM timeout, malformed JSON, missing cmux, target disappearance mid-chain
- Planner env validation: warn on startup if planner enabled but endpoint unreachable
- Documentation: update `docs/` with new capability summary, env var reference, example workflows
- Direct cmux execution guard audit: verify no new code outside `src/cmux/` calls cmux directly
- Test count tracking: baseline 164 tests → target 220+ after all 10 tasks

**Out of scope:**
- New capabilities beyond tasks 001-009
- UI/dashboard changes
- Pi bridge changes

## Checklist

- [ ] Rewrite `buildPlannerSystemPrompt` to include complete tool inventory from all 10 tasks
- [ ] Add 3+ concrete multi-step examples to planner prompt (chain, summarize→draft, watch→alert)
- [ ] Audit deterministic router: every new action kind (read_surface, summarize_target, read_sidebar, list_status, read_file, dismiss_notification, mark_notification_read, open_notification, jump_to_unread, clear_notifications, inspect_notification, memory_*, chain, browser_*, shell_exec, focus_*, watcher_*) must have at least one deterministic pattern
- [ ] Add deterministic patterns for any missing actions
- [ ] Add end-to-end integration test: `"check the Powerco tab and tell me what the redundant files are"` → chain executes: read surface → summarize → draft message
- [ ] Add end-to-end integration test: `"watch the main workspace and alert me if tests fail"` → watcher starts, polls, detects failure, notifies
- [ ] Add end-to-end integration test: full notification lifecycle (read → inspect → dismiss → clear)
- [ ] Add end-to-end integration test: two-turn conversation with memory (`"read Powerco"` → `"summarize it"`)
- [ ] Add planner error test: LLM returns malformed JSON → daemon returns graceful no-action
- [ ] Add planner error test: LLM endpoint timeout → daemon returns graceful no-action
- [ ] Add chain error test: target disappears mid-chain → chain aborts with clear error
- [ ] Add startup warning: if `ALFRED_PLANNER_ENABLED=true` but endpoint unreachable, log warning
- [ ] Run `rg -n "execFile|exec\(.*cmux|runCmux" src/daemon src/planner src/loops src/storage src/dashboard src/cli src/contracts src/actions src/router src/validation src/memory` — must return no matches
- [ ] Document all new env vars in a `docs/plans/alfred-core-capabilities/env-reference.md` or similar
- [ ] Verify `npm run check` passes with 220+ tests and zero regressions

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/actions.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/router.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/memory.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/shell-validation.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/integration.test.ts` — all pass (new test file)
- [ ] Run `npm run check` — 220+ tests passing, zero regressions
- [ ] Manual daemon smoke with planner enabled: POST flexible phrase, verify chain executes

## Completion Criteria

- [ ] Planner system prompt documents all ~30 tool shapes across all 5 capabilities
- [ ] Every new action has both deterministic and planner paths
- [ ] The signature phrase `"check in my main workspace and then look at the powerco tab and ask what are the redundant files"` works end-to-end
- [ ] Watchers start, poll, decide, and notify without manual intervention
- [ ] Conversation memory carries context across turns
- [ ] Browser actions, shell commands, and notification management all function through grants and confirmations
- [ ] No direct cmux execution outside `src/cmux/`
- [ ] 220+ tests passing, zero regressions from baseline 164
- [ ] Documentation covers all new capabilities, env vars, and example workflows

## Notes

- This is the integration and polish task. The bulk of implementation is in tasks 001-009. This task ties everything together.
- The planner prompt rewrite is critical — it's the LLM's only window into what Alfred can do. It must be clear, concise, and include concrete examples of the most valuable workflows.
- Integration tests should use fake/deterministic planners (not real LLM calls) for reliability and speed.
- The direct cmux execution guard must be verified with `rg` and also enforced by code review of every file changed in tasks 001-009.
