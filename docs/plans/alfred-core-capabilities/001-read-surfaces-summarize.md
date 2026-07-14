# 001 - Read Surfaces & Summarize

## Goal

Register `cmux.readSurface` as a safe Alfred action, add a `summarize_target` planner intent that reads surface content and pipes it through the LLM to answer questions, and wire both through deterministic router + planner fallback.

## Dependencies

- Requires: None
- Blocks: 004, 005, 009, 010

## Scope

**In scope:**
- Register `cmux.readSurface` action in `src/actions/index.ts` (safe risk level)
- Add `read_surface` planner intent kind in `src/planner/index.ts`
- Add `summarize_target` planner intent kind with `targetPhrase`, `targetKindHint`, and `question` fields
- Daemon handler for `summarize_target`: resolve target → read surface → call LLM with surface text + question → return display text
- Deterministic router support: `"what's on the Powerco tab"`, `"read the Powerco tab"`, `"summarize the current tab"` (must not collide with existing `"read notifications"` — router checks `isReadNotificationsInput` first)
- Planner prompt update: add `read_surface` and `summarize_target` to allowed tools
- Pipe surface content through existing `AlfredLlmPlannerConfig` for summarization (reuse planner endpoint/model)
- Action handler context must include `readSurface` from cmux adapter
- Apply surface text size limit for ALL reads (not just summarize): default 64KB raw, 16KB for summarization context window
- Pass cmux `lines` parameter to `readSurface` (default 1000 lines) to limit terminal history at the cmux level before it reaches Alfred

**Out of scope:**
- Reading file contents on disk (Task 002)
- Multi-step chains (Task 005)
- Conversation memory integration (Task 004)

## Checklist

- [ ] Register `cmux.readSurface` as safe action in action registry with `validateInput`, `buildPreview`, and `handler`
- [ ] Add `read_surface` and `summarize_target` to `AlfredPlannerIntent` union type
- [ ] Add `summarize_target` validation in `validatePlannerIntent` (requires `targetPhrase`, optional `targetKindHint`, required `question`)
- [ ] Add summarization LLM call in `executePlannerIntent` daemon handler: read surface → build summarization prompt → call planner endpoint → return result
- [ ] Wire `readSurface` into `ActionHandlerContext` type so action handlers can call it
- [ ] Add surface text size limit for ALL read paths (default 64KB raw, env `ALFRED_MAX_SURFACE_CHARS`). Truncate with `…[truncated N bytes]` suffix. This applies to both `read_surface` and `summarize_target` — summarization additionally caps at 16KB for LLM context.
- [ ] Pass cmux `lines` parameter (default 1000, env `ALFRED_MAX_SURFACE_LINES`) to `readSurface` to prevent cmux from returning unbounded terminal history
- [ ] Add deterministic router patterns: `read_surface` for `"read the <target>"` / `"read <target> tab"` (ordered after `isReadNotificationsInput` check to avoid collision), `summarize` for `"what's on <target>"` / `"summarize <target>"`
- [ ] Update planner system prompt with `read_surface` and `summarize_target` tool shapes
- [ ] Add surface text size limit (e.g., 16KB) to avoid blowing out LLM context window
- [ ] Add planner unit tests for `read_surface` and `summarize_target` parsing/validation
- [ ] Add daemon integration tests: `summarize_target` resolves target, reads surface, returns summary
- [ ] Add daemon test: `summarize_target` with missing target returns clarification
- [ ] Add daemon test: surface read failure returns graceful error
- [ ] Add daemon test: surface content exceeds 64KB limit → truncated with indicator, not silently cut
- [ ] Add daemon test: `lines` parameter caps terminal history at cmux level before transmission

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass including new read/summarize tests
- [ ] Run `node --test --experimental-strip-types test/actions.test.ts` — all pass
- [ ] Run `npm run check` — 164+ tests passing, zero regressions

## Completion Criteria

- [ ] `cmux.readSurface` is registered as a safe action and can be called through the action registry
- [ ] `read_surface` and `summarize_target` planner intents are parsed, validated, and executed by the daemon
- [ ] Deterministic `"read the Powerco tab"` and `"what's on the main tab"` resolve and return surface content (does not collide with `"read notifications"`)
- [ ] Planner `summarize_target` reads surface text, calls LLM, and returns a summary answer
- [ ] Missing target produces clarification response, not crash
- [ ] Surface read failure produces graceful error, not crash
- [ ] Surface read returns content even when very large, but truncated with clear indicator and continuation hint
- [ ] All existing tests pass

## Notes

- Surface text must be truncated to prevent LLM context overflow. Default 16KB for summarization context, 64KB for raw reads, both configurable via `ALFRED_MAX_SURFACE_CHARS`.
- The cmux `readSurface` adapter method accepts an optional `lines` parameter. Always pass `lines` (default 1000, configurable via `ALFRED_MAX_SURFACE_LINES`) to prevent cmux from returning unbounded terminal scrollback history. This is the first and most important defense — truncation at the cmux level before data reaches Alfred.
- **Unbounded read hardening (critical):** Without a `lines` cap, `"read the Powerco tab"` could pull 10MB+ of terminal history, exhausting memory and blowing out any downstream processing. The defense is layered: (1) cmux `lines` parameter caps at the source, (2) Alfred enforces a byte-level cap on the response, (3) truncation always carries a visible indicator so the user knows content was cut.
- Summarization reuses the planner's LLM endpoint/model but with a different system prompt (summary mode, not planning mode).
- The `readSurface` cmux adapter method already exists at `src/cmux/index.ts:332`. It takes `surfaceRef` and optional `lines` parameter.
