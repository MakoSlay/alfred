# 001 - Runtime Contracts and Event Model

## Goal

Define the typed contracts for the standalone Alfred runtime before building the server or UI.

## Scope

Create contract definitions and examples for requests, responses, actions, targets, events, state, and history. Prefer plain TypeScript types plus JSON examples that can be shared by daemon, CLI, web UI, and Pi bridge.

## Checklist

- [x] Define `AlfredHandleRequest` and `AlfredHandleResponse` contracts.
- [x] Define source/interface contracts for Pi `/alfred`, CLI, web UI, and future voice/text input surfaces.
- [x] Define target contracts for cmux workspaces, surfaces, Pi chats, Codex sessions, and unknown terminals.
- [x] Define action contracts for draft, confirm, cancel, send, loop start, loop stop, and status.
- [x] Define event/history contracts for dashboard rendering and debugging.
- [x] Define redaction and retention fields for transcript snippets, prompt text, and action history.
- [x] Define daemon error, fallback, and capability/permission semantics.
- [x] Add contract examples for the Powerco/Power Code draft-confirm flow.

## Tests

When contracts exist in the new standalone project, add tests that validate representative JSON fixtures round-trip through the exported types/helpers.

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

If the task only creates documentation before the project exists, record that and defer executable contract tests to Task 002.

## Completion Criteria

- [x] Contracts are documented or implemented in the standalone project.
- [x] Examples show Pi and non-Pi input sources and targets.
- [x] Error/fallback behavior is explicit.
- [x] Sensitive data retention and redaction behavior is explicit.
- [x] Action capability boundaries are explicit.
- [x] Validation results are recorded below.

## Notes

Runtime contracts were documented in:

```text
docs/contracts/runtime-contracts.md
```

The contract draft intentionally stays above daemon endpoint design and defines shared shapes for the future TypeScript modules:

- `AlfredHandleRequest` / `AlfredHandleResponse` with source, input, context, policy, actions, events, errors, fallback, and state patch fields.
- Source/interface model for Pi `/alfred`, CLI, browser/web UI, voice, text, system, including presentation preferences and local trust/capability fields.
- Target model for cmux workspaces, cmux surfaces, Pi chats, Codex sessions, generic terminals, and unknown targets.
- Action model for `draft`, `confirm`, `cancel`, `send`, `loop.start`, `loop.stop`, `loop.status`, and read-only `status`.
- Draft/loop state summaries and state patch fields for target memory, last speech, last sent text, and active loop tracking.
- Event/history model for dashboard-safe rendering and debugging without requiring raw transcript dumps.
- Redaction and retention metadata for draft text, sent text, transcript snippets, LLM prompt/raw output, and dashboard events.
- Error/fallback model, including `local-pi` fallback semantics for a future opt-in Pi bridge.
- Capability semantics for read vs privileged terminal send/loop operations, with web UI sources starting read-only until protected by host/origin/auth/CSRF checks.

The Powerco/Power Code example shows the important safety behavior: Alfred resolves a fuzzy/named Pi chat target, creates a pending draft, asks for confirmation, and only records a send after a later confirmed cmux send succeeds. A non-Pi CLI status example confirms that the contract is not Pi-only.

Executable TypeScript contracts and JSON fixture round-trip tests are deferred to Task 002 because the repo does not yet have `package.json`, TypeScript, or a test runner.

## Validation

- Created `docs/contracts/runtime-contracts.md` in `/Users/muhammadabdul/work/alfred`.
- Confirmed `/Users/muhammadabdul/work/alfred` does not yet have `package.json`; executable `npm run check`, `npm run typecheck`, and `npm test` gates are therefore Task 002 work.
- Ran plan consistency grep for stale project-name and template-placeholder patterns; no matches were reported.
- Did not modify `/Users/muhammadabdul/work/pi-smart-voice-notify`; Pi extension gates were not required for this documentation-only task.

## Blockers

_None currently._
