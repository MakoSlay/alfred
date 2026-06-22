# 013 - Live Dashboard and Command Palette Polish

## Goal

Polish the dashboard into a live mission-control surface with command palette, panels, notifications, and loop UX built on the prior safe primitives.

## Dependencies

- Requires: 005, 006, 007, 008, 009, 010, 011, 012
- Blocks: 014

## Scope

**In scope:**
- Add command palette entry points for Ask Alfred, list targets, start watcher, stop loop, open logs, and resolve confirmations.
- Add or refine dashboard panels for summary, targets, loops, watchers, notifications, pending approvals, recent events, and status/log output.
- Improve live updates through polling or event streams without weakening auth.

**Out of scope:**
- Voice UI, mobile app, or cloud synchronization.
- Replacing cmux's own sidebar/notification UI.

## Checklist

- [ ] Add keyboard-accessible command palette with the primary Alfred actions.
- [ ] Add live summary, target graph, loop, watcher, notification, pending approval, and recent event panels.
- [ ] Add clear empty/loading/error states for every panel.
- [ ] Add dashboard toasts only for Alfred-local UX while keeping cmux notifications as the native source of truth.
- [ ] Add inspect links from summary cards to detailed state panels.
- [ ] Verify dashboard remains usable with only loopback access and the existing token model.

## Tests

- [ ] Run `npm run typecheck` and verify dashboard changes compile.
- [ ] Run `npm test` and verify dashboard rendering helpers, API calls, and auth/error handling.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA: use the command palette to ask a question, start a watcher, inspect a loop, and resolve a pending confirmation.

## Completion Criteria

- [ ] The dashboard exposes Alfred's main capabilities without requiring raw API calls.
- [ ] Live panels reflect daemon state, cmux state, and pending approvals consistently.
- [ ] Dashboard polish does not introduce unauthenticated or non-loopback action paths.

## Notes

- This task is intentionally late so UX can compose stable primitives instead of driving architecture.
