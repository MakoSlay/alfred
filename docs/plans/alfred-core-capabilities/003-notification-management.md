# 003 - Notification Management

## Goal

Register all remaining cmux notification actions (dismiss, mark read, open, jump to unread, clear, dismiss all read) as Alfred actions, add corresponding planner intents, and expose notification detail reading so Alfred can answer questions about specific notifications.

## Dependencies

- Requires: 001 (readSurface pattern, ActionHandlerContext extension)
- Blocks: 005, 009, 010

## Scope

**In scope:**
- Register `cmux.dismissNotification` as confirmation_required action
- Register `cmux.dismissAllReadNotifications` as confirmation_required action
- Register `cmux.markNotificationRead` as safe action
- Register `cmux.markAllNotificationsRead` as confirmation_required action
- Register `cmux.openNotification` as safe action (opens/focuses, no destructive effect)
- Register `cmux.jumpToUnreadNotification` as safe action
- Register `cmux.clearNotifications` as confirmation_required action
- Add planner intents: `dismiss_notification`, `mark_notification_read`, `open_notification`, `jump_to_unread`, `clear_notifications`
- Add `inspect_notification` intent: reads notification detail (title, subtitle, body) for a specific notification
- Deterministic router patterns: `"dismiss notification"`, `"mark all read"`, `"open the notification from GitHub"`, `"jump to unread"`, `"clear notifications"`
- Planner prompt update with all new notification tool shapes

**Out of scope:**
- Notification filtering by source/app (cmux limitation)
- Creating notifications (cmux doesn't support this)
- Rich notification action buttons (cmux limitation)

## Checklist

- [ ] Register all seven notification management actions in action registry with correct risk levels
- [ ] Implement `inspect_notification` daemon handler: list notifications → find by id/title match → return detail
- [ ] Add all new notification intents to `AlfredPlannerIntent` union type
- [ ] Add validation in `validatePlannerIntent` for each new intent kind
- [ ] Wire `dismissNotification`, `markNotificationRead`, `openNotification`, `jumpToUnreadNotification`, `clearNotifications`, `dismissAllReadNotifications`, `markAllNotificationsRead` into `ActionHandlerContext`
- [ ] Add deterministic router patterns for notification commands
- [ ] Update planner system prompt with notification tool shapes
- [ ] Add planner unit tests for all new notification intents
- [ ] Add daemon integration tests: dismiss notification, mark read, open notification, jump to unread, clear all
- [ ] Add daemon test: confirmation_required actions create pending drafts, not direct execution
- [ ] Add daemon test: inspect_notification with missing/ambiguous notification ID returns clarification

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/actions.test.ts` — all pass
- [ ] Run `npm run check` — zero regressions

## Completion Criteria

- [ ] All seven notification cmux methods are registered as Alfred actions with correct risk levels
- [ ] Confirmation-required actions (dismiss, dismissAllRead, markAllRead, clear) create pending drafts that require `/confirm`
- [ ] Safe actions (markRead, openNotification, jumpToUnread) execute immediately
- [ ] `inspect_notification` returns full notification detail by id or title match
- [ ] All existing notification tests (`cmux.readNotifications`) continue to pass
- [ ] All existing tests pass

## Notes

- Risk level rationale: dismissing and clearing are destructive (remove data) → confirmation_required. Marking read is safe (state change but recoverable). Opening/jumping is navigation → safe.
- `inspect_notification` should match by exact id first, then fuzzy title match. If ambiguous, return clarification with candidate list.
- The cmux adapter already has all these methods at `src/cmux/index.ts:379-429`.
- `read_notifications` (already implemented in Task 007 of the original roadmap) returns summary list. `inspect_notification` adds detail view for a single notification.
