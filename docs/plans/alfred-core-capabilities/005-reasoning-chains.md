# 005 - Multi-Step Reasoning Chains

## Goal

Extend the planner to return structured chains of intents (not just single intents), and extend the daemon to execute chains sequentially with validation at each step, enabling "look at X, then do Y based on what you see" workflows.

## Dependencies

- Requires: 001 (read/summarize), 002 (sidebar/file read), 003 (notification mgmt), 004 (conversation memory)
- Blocks: 009, 010

## Scope

**In scope:**
- Add `chain` planner intent kind that contains an ordered array of sub-intents
- Each sub-intent is a full validated `AlfredPlannerIntent`
- Daemon `executePlannerIntent` extended to handle chains: execute each step sequentially, validate intermediate results, pass output as context to next step
- Chain step output types: `surface_text`, `summary_text`, `notification_list`, `sidebar_state`, `file_content`
- Reference syntax: step N+1 can reference step N output via `{previous}` in message/question fields
- Chain abort on first failure: if any step fails, chain stops and returns error with progress
- Max chain length: 5 steps (configurable)
- Chain timeout: 60s total (configurable)
- Planner prompt update: add chain format example
- Deterministic router chains: `"check the Powerco tab and tell me what the redundant files are"` → chain of `[read_surface, summarize_target]`

**Out of scope:**
- Parallel step execution
- Conditional branching (if/then in chain)
- Loop/repeat steps
- Chain persistence across daemon restarts

## Checklist

- [ ] Add `chain` to `AlfredPlannerIntent` union: `{ kind: "chain"; steps: AlfredPlannerIntent[] }`
- [ ] Add chain validation: each step must be valid, max 5 steps, no nested chains, no send/draft as intermediate steps
- [ ] Implement `executeChain` in daemon: sequential execution with step output capture
- [ ] Implement `{previous}` reference resolution: replace `{previous}` in step message/question with prior step output
- [ ] Add chain abort on failure: if step N fails, return error with `chainProgress` showing completed steps
- [ ] Add `chainTimeout` config (env `ALFRED_CHAIN_TIMEOUT_MS`, default 60000)
- [ ] Add `maxChainSteps` config (env `ALFRED_MAX_CHAIN_STEPS`, default 5)
- [ ] Update planner system prompt with chain format and examples
- [ ] Add planner unit test: chain parsing and validation
- [ ] Add planner unit test: nested chain rejected
- [ ] Add planner unit test: chain exceeds max steps rejected
- [ ] Add daemon test: two-step chain (read surface → summarize) executes sequentially
- [ ] Add daemon test: chain with `{previous}` reference resolves correctly
- [ ] Add daemon test: chain abort on step failure returns partial progress
- [ ] Add daemon test: chain timeout aborts with progress
- [ ] Add daemon test: chain with send/draft as intermediate step rejected

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass including chain tests
- [ ] Run `npm run check` — zero regressions

## Completion Criteria

- [ ] Planner can emit `{ "kind": "chain", "steps": [...] }` with up to 5 valid sub-intents
- [ ] Daemon executes chains sequentially, passing output between steps via `{previous}`
- [ ] The phrase `"check in my main workspace and then look at the powerco tab and ask what are the redundant files"` executes as a chain: resolve Powerco → read surface → summarize for redundant files → draft message
- [ ] Chain failure at any step returns clear error with completed step count
- [ ] Chain timeout prevents runaway execution
- [ ] Nested chains, oversized chains, and chains with intermediate sends are all rejected
- [ ] All existing tests pass

## Notes

- Chain steps execute in the same request context. Targets are re-resolved at each step (in case they disappear mid-chain).
- `{previous}` substitution happens before each step executes. The daemon replaces the literal string `{previous}` in the next step's `message` or `question` field with the trimmed output of the prior step.
- If the prior step returns structured data (e.g., sidebar state), it is serialized as a compact JSON summary before substitution.
- Chain results include a `chainProgress` array showing step number, intent kind, status (completed/failed), and summary for each step.
- The planner prompt should include a concrete example: read surface → summarize → draft message.
