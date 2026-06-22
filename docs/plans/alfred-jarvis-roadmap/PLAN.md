# Alfred Jarvis Roadmap - Master Plan

## Purpose

- Turn Alfred from a dependable cmux-backed cockpit into an actionful local assistant while preserving the stable daemon/dashboard foundation.
- Add planner, permission, watcher, cmux-native UX, and proactive monitoring capabilities without duplicating cmux primitives.
- Keep each capability shippable behind explicit tests, confirmations, and safe fallbacks.

## How to Use

1. Work tasks in order unless dependencies indicate otherwise.
2. Check items in task files as they are completed.
3. This file is the index only; details live in task files.

## Decisions (Locked)

- cmux owns panes, workspaces, surfaces, notifications, unread state, sidebar status, logs, markdown, diff, browser, and terminal I/O primitives.
- Alfred owns intent, planning, permissions, target memory, watchers, loop orchestration, confirmations, audit history, and summaries.
- Ask Alfred uses one internal ask pipeline; `POST /ask` is the primary dashboard/CLI/Pi `/alfred` endpoint, while legacy `POST /handle` remains a compatibility wrapper into the same pipeline.
- Generic `PendingAction` replaces draft-specific approval state as the source of truth in the approval-card migration phase. Task 002 defines the contract and registry semantics; Task 006 performs the daemon/dashboard migration. Message drafts are one editable pending action type, not a separate model.
- User-facing proactive automations are called **watchers**. Internal recipe/schema code is acceptable, but UI and docs should say watcher.
- Active watchers clear on daemon restart. Persisted watcher configuration, target memory, audit history, and safe metadata may remain.
- Watchers may auto-send only when the user explicitly grants that permission for the specific watcher, target, and scope.
- Target nicknames are user-friendly aliases for cmux targets. Workspace-local aliases win, global aliases are fallback, exact cmux titles/recent targets can help resolution, and ambiguity asks clarification instead of guessing.
- Safe local cmux read/open/show actions can run without confirmation: read/list targets, read notifications, open diff/markdown/file/URL/browser surfaces, jump/focus/open cmux UI, and write Alfred status/progress/log entries to the cmux sidebar.
- Confirmation is required for terminal sends, keypresses, browser click/type/eval without a temporary grant, shell execution, close/delete/clear destructive state, and starting watchers with auto-send permission.
- Browser click/type/eval uses temporary, scoped permission grants such as one action, a short time window, or this session; read/open/snapshot remains safe.
- Deterministic routing and validation must remain the fallback even after LLM planning improves.
- cmux CLI command syntax must be verified against the installed cmux before locking adapter fixtures; known verified shapes are recorded in Task 001.
- Pi-local fallback and daemon opt-in behavior must not regress.

## Task Index

- [ ] 001 - Cmux Adapter Foundation (`001-cmux-adapter-foundation.md`)
- [ ] 002 - Tool Registry and Permission Model (`002-tool-registry-permission-model.md`)
- [ ] 003 - Target Memory and Alias Resolution (`003-target-memory-alias-resolution.md`)
- [ ] 004 - Deterministic Intent Router (`004-deterministic-intent-router.md`)
- [ ] 005 - Ask Alfred Dashboard Input (`005-ask-alfred-dashboard-input.md`)
- [ ] 006 - Pending Action Cards (`006-draft-confirm-action-cards.md`)
- [ ] 007 - Cmux Notification Bridge (`007-cmux-notification-bridge.md`)
- [ ] 008 - Loop State in Cmux Sidebar (`008-loop-state-cmux-sidebar.md`)
- [ ] 009 - Watcher Recipe System (`009-recipe-system.md`)
- [ ] 010 - Proactive Watchers (`010-proactive-monitoring-recipes.md`)
- [ ] 011 - Current State Summary (`011-current-state-summary.md`)
- [ ] 012 - Rich Cmux UX Actions (`012-rich-cmux-ux-actions.md`)
- [ ] 013 - Live Dashboard and Command Palette Polish (`013-live-dashboard-command-palette-polish.md`)
- [ ] 014 - Validation and Release Hardening (`014-validation-release-hardening.md`)

## Completion

- [ ] All tasks in the index are checked.
- [ ] All tests listed in task files pass.
- [ ] Alfred can answer, plan, confirm, execute safe cmux-backed actions, monitor key workflows, and explain current local state from the dashboard.
- [ ] No Alfred feature duplicates cmux UI primitives when a native cmux command already exists.
