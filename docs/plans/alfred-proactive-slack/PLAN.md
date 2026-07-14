# Alfred Proactive + Slack — Plan Index

Canonical implementation plan: `docs/plans/alfred-proactive-slack/IMPLEMENTATION.md`.

This directory plans Alfred 2's proactive personal-assistant/watchers system:

- wellness reminders for breaks/lunch/dinner;
- Zoom/Slack huddle awareness to avoid poor interruptions;
- semantic stuck-work detection;
- Slack attention summaries and todo extraction;
- Apple Notes `Alfred Todo` as the editable source of truth.

## Architecture Boundary

This work extends existing Alfred 2 under `src/alfred-2/`. New code should use:

```txt
src/alfred-2/proactive/
src/alfred-2/activity/
src/alfred-2/watchers/
src/alfred-2/slack/
src/alfred-2/notes/
```

Do not add top-level `src/watchers`, `src/slack`, `src/activity`, or a second proactive daemon/state singleton.

## Required Prerequisite

Before adding dashboard controls or new mutating/control endpoints, complete or honor:

- `docs/plans/alfred-2-stabilization/002-server-dashboard-security.md`

## Implementation Order

```txt
001 → 002 → 003 → 006 → 005 → 004
```

1. `001-interruption-policy.md` — central proactive event/delivery policy.
2. `002-active-work-meeting-awareness.md` — fail-closed activity detection and fuzzy meeting state.
3. `003-wellness-watchers.md` — break/lunch/dinner watchers.
4. `006-apple-notes-todo.md` — safe editable todo source of truth.
5. `005-slack-attention-and-cache.md` — least-privilege on-demand Slack attention; no cache in Phase 1.
6. `004-semantic-stuck-work-watcher.md` — opt-in semantic stuck/stopped-work detection.

## Locked Decisions

See `USER-DECISIONS.md`. The most important implementation constraints are:

- mute suppresses all proactive speech and interruptive notifications;
- urgent bypasses cooldown, not mute;
- Slack external LLM classification is opt-in only;
- Slack Phase 1 is on-demand and ephemeral; no background poller/cache;
- Apple Notes Phase 1 is append-only with confirmation; no full sync/merge engine;
- stuck-work must use resolved cmux workspace/cwd, never Alfred process `pwd`.
