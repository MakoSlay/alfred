# Alfred Autonomous Tool Agent - Master Plan

## Purpose

- Upgrade Alfred 2.0 from a single-command voice butler into a pi-like local agent that can inspect, act, observe failures, recover, and then speak a concise result.
- Deliver the practical pi capabilities Alfred is missing now: multi-turn memory, structured file tools, web/search/content tools, CI tools, error recovery, and process hardening.
- Preserve Alfred's current philosophy: voice-first, concise speech, no Alfred 1.x action-registry/planner revival, and confirmation for dangerous work.

## How to Use

1. Work tasks in order; dependencies are intentionally strict.
2. Check items in task files as they are completed.
3. This file is the index only; implementation detail lives in numbered task files.
4. Do not start implementation-heavy tasks until 001 and 002 are complete.

## Decisions (Locked)

- Alfred remains voice-first: user speaks, Alfred reasons, tools run, Alfred speaks a concise result.
- No subagents or intercom in this phase; design the tool contract so those can be added later without replacing the loop.
- Keep Alfred 2.0 standalone for now. Do not require running inside pi to gain these capabilities.
- Prefer a small general tool dispatcher over one-off hardcoded command paths. This is not a return to Alfred 1.x's action registry.
- Every tool call must carry explicit execution context: request id, tool call id, cwd/workspace target when relevant, timeout, and risk classification.
- cmux is the source of truth for where Alfred acts; conversation memory is the source of truth for what the user is referring to; Alfred must never silently substitute its own process cwd or repo.
- Every mutating or destructive operation must go through confirmation using a pending-call id/hash; never re-ask the LLM and hope it emits the same dangerous command.
- Existing Alfred 1.x tests and behavior must not regress.
- cmux remains accessed through the CLI/context path Alfred 2.0 already uses; do not reintroduce the old cmux adapter/action-registry architecture.
- Alfred is personal-local software for this phase, not a distributable multi-user product.
- Tool outputs are curated before being sent back to the LLM. The goal is reliability and safety, not token penny-pinching; large output is allowed when useful, but secrets/noisy dumps should not silently enter future memory.
- Workspace/cwd behavior is defined in `workspace-resolution.md` and is part of the tool contract, not an implementation detail.
- Parser behavior is defined in `parser-contract.md`; malformed/ambiguous model output is never executed.
- Request context fetching is defined in `context-model.md`; Alfred should use compact always-on context plus cached/on-demand detailed references.
- Alfred sessions have a hard continuity threshold of 100k tokens. At ~80k tokens Alfred should warn/prep a compact handoff; at 100k tokens Alfred should generate a handoff and ask the user to continue in a fresh session.

## Reference Specs

- Workspace and CWD Resolution (`workspace-resolution.md`)
- Operational Decisions (`operational-decisions.md`)
- Parser Contract (`parser-contract.md`)
- Context Model (`context-model.md`)
- Implementation Defaults (`implementation-defaults.md`)

## Task Index

- [x] 001 - Capability Inventory & Tool Contract (`001-capability-inventory-tool-contract.md`)
- [x] 002 - Process Management & Test Harness (`002-process-management-test-harness.md`)
- [x] 003 - Multi-Tool Agent Loop (`003-multi-tool-agent-loop.md`)
- [x] 004 - Conversation Memory Context (`004-conversation-memory-context.md`)
- [x] 005 - First-Class File Tools (`005-first-class-file-tools.md`)
- [x] 006 - Web Search & Content Fetching (`006-web-search-content-fetching.md`)
- [x] 007 - CI Status & Log Tools (`007-ci-status-log-tools.md`)
- [x] 008 - Error Recovery, Safety, and Confirmation (`008-error-recovery-safety-confirmation.md`)
- [x] 009 - Integration Tests, Docs, and Ship (`009-integration-tests-docs-ship.md`)

## Completion

- [x] Alfred can run multi-step tool workflows from one spoken request.
- [x] Alfred can resolve which workspace/cwd a tool should run in instead of accidentally operating in the Alfred repo.
- [x] Alfred can read, write, and precisely edit files safely.
- [x] Alfred can search the web, fetch readable URL content, and answer with current information when a provider is configured.
- [x] Alfred can check CI and summarize failing job logs from the relevant repo/workspace.
- [x] Alfred remembers recent turns well enough for references like "that file" or "the workspace I just opened" without injecting sensitive large outputs.
- [x] Alfred tracks approximate session token usage and generates a usable handoff before crossing 100k tokens.
- [x] Alfred retries or recovers from common command/tool failures instead of stopping at the first error.
- [x] Alfred starts/stops cleanly with no zombie process accumulation.
- [x] `npm run check` passes with no regressions.
