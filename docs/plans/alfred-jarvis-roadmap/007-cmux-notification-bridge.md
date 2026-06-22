# 007 - Cmux Notification Bridge

## Goal

Bridge Alfred's dashboard and daemon state to native cmux notifications instead of creating a separate notification system.

## Dependencies

- Requires: 001
- Blocks: 010, 011, 013

## Scope

**In scope:**
- Read cmux notifications using `cmux list-notifications --json --id-format both`.
- Stream or poll cmux notification events using `cmux events` where reliable; polling remains the required fallback.
- Expose `open-notification`, `dismiss-notification`, `mark-notification-read`, `jump-to-unread`, and `clear-notifications` through the permission model; read/list/jump/open are safe, while destructive clear-all or broad dismiss actions require confirmation.
- Render notification state in the dashboard with workspace and surface context.

**Out of scope:**
- Replacing cmux notifications with a separate Alfred notification center.
- External Slack/email/mobile notification integrations.

## Checklist

- [ ] Use the adapter methods for list, open, dismiss, mark-read, jump-to-unread, and clear notification commands; add missing methods only in `src/cmux/index.ts`.
- [ ] Add daemon endpoint or state channel for notification snapshots.
- [ ] Add event-stream integration with reconnect/cursor behavior if cmux events are stable enough.
- [ ] Render notification list with unread/read state, title, subtitle, body, workspace, surface, and timestamp.
- [ ] Add dashboard controls for safe notification actions.
- [ ] Add fallback polling if event streaming is unavailable.

## Tests

- [ ] Run `npm run typecheck` and verify notification contracts compile.
- [ ] Run `npm test` and verify JSON parsing, event/poll fallback, and notification action policy checks.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA inside cmux: create a test notification, see it in Alfred, mark it read, and jump to unread.

## Completion Criteria

- [ ] Alfred displays native cmux notifications with correct read/unread state.
- [ ] Dashboard notification actions call cmux safely through the adapter and registry.
- [ ] Alfred does not maintain a duplicate notification source of truth.

## Notes

- `oh-my-pi` already emits useful Pi lifecycle notifications; Alfred should consume and act on them rather than replace them.
- Reading cmux notifications is safe by default. Opening/jumping to a notification is safe local UI navigation. Clearing/dismissing broad notification state should be treated as confirmation-required if it is destructive or hard to undo.
- `cmux events` should not be a hard dependency until reconnect/cursor behavior is tested; dashboard state must work via polling.
