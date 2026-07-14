# Alfred 2.0 — Voice-First Local Agent - Master Plan

## Purpose

- Replace Alfred 1.x's daemon/router/planner/action-registry/cmux-adapter architecture with a simpler, direct model: **voice in → pre-injected context → LLM with bash tools → speech out**.
- Alfred 2.0 runs inside pi's process (no separate daemon). It uses pi's existing `bash`, `read`, and `write` tools. It calls cmux CLI directly (no adapter layer). It pre-gathers system state so the LLM never wastes tokens on discovery.
- The user speaks via Wispr Flow, sees activity in pi's terminal, and hears spoken responses. Alfred 2.0 is a local mini-agent with an API token for its brain.

## How to Use

1. Work tasks in order; each builds on the previous.
2. Check items in task files as they are completed.
3. This file is the index only; details live in task files.

## Decisions (Locked)

- **No daemon process.** Alfred 2.0 runs inside pi as an extension or inline tool. No separate HTTP server, no port, no auth token (pi handles auth).
- **No cmux adapter.** Call `cmux` CLI directly via bash. No `CmuxWorldModelAdapter`, no `execFile` wrappers, no type-safe cmux interfaces. cmux CLI output is parsed as-needed.
- **No action registry.** The LLM's tool is `bash`. It can run any command pi's bash tool allows. Safety comes from confirmation prompts, not from an allowlist of action types.
- **No planner types.** LLM output is free-form text with embedded bash commands, or structured JSON with `{ speech, command }`. No `AlfredPlannerIntent` union, no `validatePlannerIntent`.
- **Context pre-injection is mandatory.** Before every LLM call, gather: all workspaces, their git branches/dirty status, open PRs, sidebar state, notifications, recent git log. Inject as a compressed "STATE OF YOUR SYSTEM" block. The LLM must never run `cmux workspace list` or `git status` — it already knows.
- **Pi's bash tool does the work.** No new execution primitives. If pi can't run it, Alfred 2.0 can't either. This means Alfred 2.0 inherits pi's capabilities and security model.
- **Mute carries forward.** The mute feature added to Alfred 1.x is ported to Alfred 2.0 (in-memory flag, speech stripping).
- **Confirmation is vocal.** Destructive commands (rm, git push, npm publish, etc.) prompt the user: "Shall I run `rm -rf node_modules`?" User says yes/no. No draft system, no pending action IDs.
- **Version naming:** Alfred 2.0. The 1.x line is the daemon-based architecture. 2.0 is the simplified voice-first architecture. Both can coexist — 1.x daemon keeps running for dashboard/cmux-surface features; 2.0 is the voice path.

## Task Index

- [ ] 001 - Context Gatherer (`001-context-gatherer.md`)
- [ ] 002 - LLM Agent Core (`002-llm-agent-core.md`)
- [ ] 003 - Pi Extension & Voice Wiring (`003-pi-extension-voice.md`)
- [ ] 004 - Confirmation Guard (`004-confirmation-guard.md`)
- [ ] 005 - Mute Port (`005-mute-port.md`)
- [ ] 006 - Token Budget & Observability (`006-token-budget.md`)
- [ ] 007 - Testing, Migrate & Ship (`007-testing-ship.md`)

## Completion

- [ ] All tasks in the index are checked.
- [ ] All tests listed in task files pass.
- [ ] User says "what's happening in my sandbox workspace" → Alfred 2.0 pre-injects context, LLM reads the pre-gathered state, speaks "Your sandbox has 5 tabs, PR #3130 is open with all checks green, branch is clean."
- [ ] User says "open Chrome" → Alfred 2.0 runs `open -a "Google Chrome"` via bash, speaks "Chrome is opening."
- [ ] User says "mute for 30 minutes" → Alfred 2.0 mutes, no speech for 30 min, queries still work silently.
- [ ] User says "run npm test in alfred and tell me if it passes" → Alfred 2.0 runs the command, reads output, speaks result.
- [ ] Token report shows: "Context pre-injection saved ~12,000 tokens (7 discovery commands skipped). LLM call used 3,400 tokens. Total: 3,400."
- [ ] Alfred 1.x daemon continues to work alongside Alfred 2.0 — no regression.
