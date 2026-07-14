# Alfred 2 Stabilization — Voice-Agent Server Plan

## Purpose

- Align Alfred 2 with what it has become: a standalone local voice-agent server with a dashboard, Wispr input, a bounded LLM tool loop, memory, confirmations, undo, and speech output.
- Stop treating Alfred 2 as Alfred 1 with more actions. Alfred 1 is the typed cmux control daemon; Alfred 2 is the voice-first operator loop.
- Prioritize safety, reliability, observability, and real spoken workflow quality over adding more capabilities.

## Current Reality

Alfred 2 currently has:

- HTTP server and dashboard (`src/alfred-2/server.ts`, `src/alfred-2/dashboard.ts`).
- Wispr listener and speech output.
- Strict model parser and multi-tool loop.
- Bash, file, web, CI, remember/recall tools.
- Session memory, token handoff, profile facts, undo, mute, auto-confirm, and pending confirmations.

This differs from the original `docs/plans/alfred-2/PLAN.md`, which assumed no daemon/server and no dashboard. This plan supersedes that assumption for stabilization work.

## Guiding Principles

- Alfred 2 is a voice-first local agent, not an Alfred 1 action-registry rewrite.
- The tool loop is the product core: observe, act, recover, then speak concisely.
- CWD/workspace correctness is a safety invariant, not a convenience.
- Local server/dashboard endpoints must be hardened because they can mutate files and run commands.
- Risky work confirms an exact stored payload and exact stored execution context.
- Add capabilities only after the core loop is boringly reliable in real voice use.

## Task Index

- [ ] 001 — Architecture Decision & Boundary Cleanup (`001-architecture-boundary.md`)
- [ ] 002 — Local Server & Dashboard Security (`002-server-dashboard-security.md`)
- [ ] 003 — Workspace/CWD & Confirmation Invariants (`003-workspace-cwd-confirmation.md`)
- [ ] 004 — Context & Dashboard Observability (`004-context-dashboard-observability.md`)
- [ ] 005 — Voice Workflow Smoke Matrix (`005-voice-workflow-smoke.md`)
- [ ] 006 — Docs, Runbook, and Migration Notes (`006-docs-runbook-migration.md`)
- [ ] 007 — Stabilization Ship Gate (`007-ship-gate.md`)

## Completion Criteria

- [ ] Alfred 2 architecture is documented as a standalone local voice-agent server.
- [ ] Dashboard and mutation endpoints are protected by loopback/origin/auth/CSP/no-store controls.
- [ ] Every tool execution records and uses an explicit resolved cwd/workspace; no accidental fallback to Alfred's repo.
- [ ] Confirmations execute the exact stored payload and exact stored cwd/workspace from the original approval prompt.
- [ ] Dashboard shows enough live state to debug real voice requests: workspace/cwd, tokens, memory, confirmations, tools, mute, auto-confirm, recent tool events.
- [ ] A manual spoken smoke matrix passes for the core workflows.
- [ ] `npm run check` passes.
