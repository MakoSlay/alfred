# 011 - Current State Summary

## Goal

Implement Alfred's "what's going on?" summary using cmux topology, notifications, sidebar state, loops, watchers, pending approvals, and target memory.

## Dependencies

- Requires: 001, 003, 004, 007, 008, 010
- Blocks: 013, 014

## Scope

**In scope:**
- Summarize active workspaces, current/caller surface, unread notifications, active loops, pending confirmations, running watchers, aliases, ports, and recent errors.
- Expose the summary through Ask Alfred, daemon API, CLI if present, and dashboard.
- Keep summaries concise, factual, and linked to inspectable underlying state.

**Out of scope:**
- Long narrative reports or speculative root-cause analysis.
- Reading sensitive terminal scrollback unless explicitly requested and permissioned.

## Checklist

- [ ] Define summary data model with sections for cmux, notifications, loops, approvals, targets, and warnings.
- [ ] Implement summary builder from existing adapter and daemon state without duplicating storage.
- [ ] Add Ask Alfred route for "what's going on", "summarize state", and similar phrases.
- [ ] Add dashboard summary card with links to detailed panels.
- [ ] Add warning logic for stale aliases, failed loops, unread errors, and pending approvals.
- [ ] Document exactly which data sources the summary uses.

## Tests

- [ ] Run `npm run typecheck` and verify summary model types compile.
- [ ] Run `npm test` and verify empty, normal, warning-heavy, and cmux-unavailable summary cases.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA: ask "what's going on?" with at least one unread notification and one active loop and verify both appear.

## Completion Criteria

- [ ] Alfred can produce a concise current-state summary from live daemon state.
- [ ] Summary output distinguishes known facts from unavailable data.
- [ ] Dashboard and Ask Alfred use the same summary builder.

## Notes

- This feature is the core Jarvis-feeling checkpoint; keep it trustworthy and non-magical.
