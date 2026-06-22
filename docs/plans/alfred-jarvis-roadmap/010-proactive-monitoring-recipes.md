# 010 - Proactive Watchers

## Goal

Ship the first high-value proactive watchers for CI, tests, PRs, sessions, and dev servers.

## Dependencies

- Requires: 007, 008, 009
- Blocks: 011, 013, 014

## Scope

**In scope:**
- Implement built-in watchers for CI, test commands, PRs, idle sessions, and dev servers.
- Notify on meaningful transitions such as pass, fail, recovered, needs approval, idle too long, or process exited.
- Use cmux notifications/sidebar/logs for local UX and pending action cards for risky follow-up actions.
- Allow auto-send only when the watcher was started with explicit permission scoped to the watcher, target, message/action type, and frequency.

**Out of scope:**
- Cloud-hosted monitoring or always-on background service outside the local daemon.
- Autonomously fixing failures without approval.
- Restarting active watchers automatically after daemon restart.

## Checklist

- [ ] Implement CI watcher with status polling, failure summary, and recovery notification.
- [ ] Implement test watcher with command lifecycle tracking and failure output summary.
- [ ] Implement PR watcher for checks, review comments, mergeability, and approval state where credentials allow.
- [ ] Implement idle session watcher using cmux tree/read-screen or available session signals, with optional scoped auto-nudge permission.
- [ ] Implement dev server watcher for exited process or port-health changes.
- [ ] Add dashboard controls and documentation for each watcher's inputs, notification behavior, and auto-send permissions.

## Tests

- [ ] Run `npm run typecheck` and verify watcher implementations compile.
- [ ] Run `npm test` and verify mocked pass/fail/recovery/idle/exited transitions.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA: run one watcher in a controlled local scenario and verify cmux notification plus sidebar state update.

## Completion Criteria

- [ ] At least five built-in watchers exist and are gated by watcher permissions.
- [ ] Each watcher produces high-signal notifications only on meaningful state transitions.
- [ ] Risky remediation actions are proposed as pending action cards, not executed silently.
- [ ] Watcher auto-send occurs only when explicitly granted for the specific watcher scope.

## Notes

- Prefer durable state transitions over noisy polling messages.
- Active watcher runtime state clears on daemon restart; persisted config/history can remain for intentional restart.
