# 004 - Deterministic Intent Router

## Goal

Add a reliable deterministic router for common Ask Alfred requests before relying on broad LLM planning.

## Dependencies

- Requires: 001, 002, 003
- Blocks: 005, 006, 009, 011, 012

## Scope

**In scope:**
- Classify inspect, message, loop, monitor, explain, remember-target, open, notification, and help intents.
- Extract simple target, message, watcher, loop, and object references.
- Return either a safe answer, a safe direct action, a pending action proposal, or a clarification question.

**Out of scope:**
- General multi-step LLM autonomous planning.
- Executing restricted shell/file/browser actions without permission checks.

## Checklist

- [ ] Define router input/output contracts independent of dashboard transport.
- [ ] Implement deterministic patterns for the first supported intents and fallback help.
- [ ] Use target resolver results to return clarification questions for ambiguous targets.
- [ ] Convert executable intents through the tool registry, allowing safe read/open/show actions to run directly and confirmation-required actions to become pending actions.
- [ ] Add planner validation that rejects unsupported or unsafe outputs.
- [ ] Add developer documentation with supported phrases and examples.

## Tests

- [ ] Run `npm run typecheck` and verify router contracts compile.
- [ ] Run `npm test` and verify intent classification, entity extraction, clarification, and unsupported intent cases.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA: ask for targets, ask to open a diff, ask to draft a message, ask to remember an alias, and verify only safe actions execute directly.

## Completion Criteria

- [ ] Common Ask Alfred commands produce deterministic, test-covered outcomes through the shared `/ask` pipeline.
- [ ] Ambiguous or unsupported commands produce safe clarification or help text.
- [ ] Router output can be consumed by dashboard, CLI/API callers, Pi `/alfred`, and legacy `/handle` compatibility.

## Notes

- LLM planning can later augment this router, but it must not replace validation and policy checks.
