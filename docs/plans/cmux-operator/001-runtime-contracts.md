# 001 - Runtime Contracts and Event Model

## Goal

Define the typed contracts for the standalone Alfred runtime before building the server or UI.

## Scope

Create contract definitions and examples for requests, responses, actions, targets, events, state, and history. Prefer plain TypeScript types plus JSON examples that can be shared by daemon, CLI, web UI, and Pi bridge.

## Checklist

- [ ] Define `AlfredHandleRequest` and `AlfredHandleResponse` contracts.
- [ ] Define target contracts for cmux workspaces, surfaces, Pi chats, Codex sessions, and unknown terminals.
- [ ] Define action contracts for draft, confirm, cancel, send, loop start, loop stop, and status.
- [ ] Define event/history contracts for dashboard rendering and debugging.
- [ ] Define redaction and retention fields for transcript snippets, prompt text, and action history.
- [ ] Define daemon error shapes and fallback semantics.
- [ ] Define a capability/permission model for read-only, draft-only, confirmed-send, and autonomous-loop actions.
- [ ] Add contract examples for the Powerco/Power Code draft-confirm flow.

## Tests

When contracts exist in the new standalone project, add tests that validate representative JSON fixtures round-trip through the exported types/helpers.

```bash
cd /Users/muhammadabdul/work/cmux-operator
npm run check
npm run typecheck
npm test
```

If the task only creates documentation before the project exists, record that and defer executable contract tests to Task 002.

## Completion Criteria

- [ ] Contracts are documented or implemented in the standalone project.
- [ ] Examples show Pi and non-Pi surfaces.
- [ ] Error/fallback behavior is explicit.
- [ ] Sensitive data retention and redaction behavior is explicit.
- [ ] Action capability boundaries are explicit.
- [ ] Validation results are recorded below.

## Notes

_To be filled during implementation._

## Validation

_To be filled during implementation._

## Blockers

_None currently._
