# 005 - Ask Alfred Dashboard Input

## Goal

Add a first-class Ask Alfred input to the dashboard that submits natural-language requests to the daemon and renders responses.

## Dependencies

- Requires: 002, 004
- Blocks: 006, 011, 013

## Scope

**In scope:**
- Add dashboard UI for entering Ask Alfred requests.
- Add authenticated `POST /ask` transport as the primary Ask Alfred endpoint.
- Preserve `POST /handle` as a compatibility wrapper into the same ask pipeline so dashboard, CLI, Pi `/alfred`, and legacy callers share one brain.
- Render safe answers, clarification questions, pending action proposals, and errors.
- Preserve local token handling and existing dashboard security constraints.

**Out of scope:**
- Voice input, external chat integrations, or unrestricted command execution.
- Polished command palette shortcuts, which are covered by Task 013.

## Checklist

- [ ] Add `POST /ask` and connect it to the deterministic router.
- [ ] Route legacy `POST /handle` requests through the same ask pipeline without breaking existing callers.
- [ ] Add dashboard input with loading, success, error, and empty states.
- [ ] Render plain answers and clarification options without requiring page reloads.
- [ ] Render pending action proposals in a minimal read-only form until Task 006 adds full cards.
- [ ] Add event/audit entries for ask request received and ask response produced.

## Tests

- [ ] Run `npm run typecheck` and verify dashboard/server changes compile.
- [ ] Run `npm test` and verify `/ask` authentication, `/handle` compatibility, router handoff, and error handling.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA: start the daemon, open `/dashboard`, enter "what targets are active", and verify a useful response appears.

## Completion Criteria

- [ ] The dashboard has a visible Ask Alfred input connected to the shared ask pipeline.
- [ ] `/ask` is the primary endpoint and `/handle` remains compatible without duplicated planning logic.
- [ ] Ask responses can include answers, clarifications, pending actions, and safe errors.
- [ ] Existing token/localhost protections remain intact.

## Notes

- Keep the first UI simple; correctness and safety matter more than polish here.
