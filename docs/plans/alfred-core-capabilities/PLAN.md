# Alfred Core Capabilities — Eyes, Memory, Chains, Actions, Awareness - Master Plan

## Purpose

- Give Alfred five foundational capabilities it currently lacks: reading/inspecting content (eyes), remembering context across commands (memory), executing multi-step reasoning plans (chains), performing real cmux-backed actions beyond open+draft (actions), and proactively monitoring+alerting (awareness).
- Every capability wraps existing cmux adapter primitives that are already implemented but not yet registered as Alfred actions or exposed through the planner.
- Ship all five capabilities together so Alfred moves from "12-button remote control" to "local operator that can see, think, remember, act, and watch."

## How to Use

1. Work tasks in order; each builds on the previous.
2. Check items in task files as they are completed.
3. This file is the index only; details live in task files.

## Decisions (Locked)

- cmux owns all terminal I/O, workspace/surface discovery, notifications, sidebar state, and pane management. Alfred never reimplements these.
- Alfred owns intent planning, permissions, target memory, confirmation, audit history, summarization, conversation memory, chain orchestration, and watcher lifecycles.
- LLM plans only; the daemon validates and executes. No LLM path directly calls cmux.
- All new actions go through the action registry with appropriate risk levels (safe, confirmation_required, restricted).
- Sends always require confirmation. Browser click/type and shell execution require temporary scoped grants.
- Conversation memory is ephemeral and session-scoped; it is not persisted across daemon restarts.
- Chains are validated structured sequences of planner intents, not free-form LLM output. Each chain step is individually validated before execution.
- Watchers auto-send only with explicit user permission for the specific watcher, target, and scope.
- Deterministic routing remains first; planner is fallback. Both pipelines must work for all new intents.
- Safe actions (read surface, read sidebar state, read notifications, open/focus targets, list status) require no confirmation.
- `npm run check` (currently 164 tests) must stay green after every task. No regressions.

## Task Index

- [ ] 001 - Read Surfaces & Summarize (`001-read-surfaces-summarize.md`)
- [ ] 002 - Sidebar State & File Reading (`002-sidebar-state-file-reading.md`)
- [ ] 003 - Notification Management (`003-notification-management.md`)
- [ ] 004 - Conversation Memory (`004-conversation-memory.md`)
- [ ] 005 - Multi-Step Reasoning Chains (`005-reasoning-chains.md`)
- [ ] 006 - Browser Interaction (`006-browser-interaction.md`)
- [ ] 007 - Shell Execution (`007-shell-execution.md`)
- [ ] 008 - Target Navigation & Focus (`008-target-navigation-focus.md`)
- [ ] 009 - Proactive Watchers & Monitoring (`009-proactive-watchers.md`)
- [ ] 010 - Integration, Planner Prompt & Hardening (`010-integration-hardening.md`)
- [ ] 011 - Mute & Silence (`011-mute-silence.md`)

## Completion

- [ ] All tasks in the index are checked.
- [ ] All tests listed in task files pass.
- [ ] `npm run check` passes with zero regressions.
- [ ] Alfred can read surface content, sidebar state, and file contents; answer questions about what it sees; manage notifications fully; remember conversation context; execute multi-step chains; interact with browsers and run shell commands with grants; navigate and focus targets; proactively monitor targets with watchers; and be muted/silenced for a timed duration.
- [ ] Alfred supports timed mute (`"mute for 30 minutes"`) that suppresses all speech and proactive notifications while allowing status queries to still return text silently.
- [ ] The flexible multi-step phrase `"check in my main workspace and then look at the powerco tab and ask what are the redundant files"` works end-to-end: reads the Powerco tab content, identifies redundant files, and drafts a message to Powerco about them — all through a validated chain.
