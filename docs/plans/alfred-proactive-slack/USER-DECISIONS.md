# Alfred Proactive + Slack — User Decisions

Captured from user clarification.

## Interruption Policy

- Alfred should speak for important things and notify for low-priority items.
- Wellness and stuck-work may speak, but only for important cases.
- Slack should stay silent unless urgent, missed, and likely forgotten. Normal Slack attention items should be notifications/dashboard/on-demand summaries.
- No fixed quiet hours for now; user typically is not on computer before 9am, but may start earlier.
- Alfred should be gentle and lightly funny: a gentle/funny butler tone, not bossy.

## Meeting Awareness

- Add meeting awareness so Alfred avoids poorly timed wellness/stuck interruptions during:
  - Zoom meetings.
  - Slack huddles.
- User can grant additional local permissions if truly needed, but implementation should start with the least invasive reliable approach.

## Wellness Watchers

- Break reminder cadence: 90 minutes of active work.
- Active work means actual user activity, not simply computer awake/on.
- If user has stopped working, Alfred should not count that as active-work time.
- Break reminders may speak when appropriate.
- Lunch window: around 2–3pm.
- Dinner window: around 8–9pm, especially if user is still working.
- User usually starts work around 10am, but earlier starts are possible.

## Stuck-Work / Struggling Chat Watcher

- This should be semantic/context-based, not just hard-coded tests or regexes.
- Alfred should periodically inspect what is going on and decide whether work is going in circles or not moving the needle.
- Check cadence: every 10 minutes.
- Alfred should be aware that the user starts new chats frequently.
- It should infer broader work context such as PRs, surveys, CSB sessions, and active project efforts where possible.
- Nudging other chats/agents:
  - Default: draft and ask user for confirmation.
  - Never auto-send by default.
  - Auto-nudge is allowed only for specific watchers explicitly approved by the user.

## Slack Attention

- User has Slack on their computer and likely can create/install an internal Slack app, but this still needs confirmation/setup.
- Primary Slack attention signal: mentions, with semantic/contextual importance.
- DMs do not automatically need attention.
- Exclude saved items/bookmarks from MVP attention.
- Exclude all unread messages from MVP attention.
- Slack should categorize/elevate based on context, not raw notification count.
- User expects to ask Alfred things like:
  - What did I miss on Slack?
  - What should I be doing?
  - What needs my attention?

## Todo and Daily Plan

- Todos should include Slack reminders.
- Todos should include contextual asks from Slack messages, such as “can you…” / “please…”, but categorized by importance and context.
- “Slack files” means Slack canvases.
- Canonical editable todo list should live in Apple Notes because the user wants to manually edit the note outside Alfred.
- Alfred may keep a local encrypted SQLite cache/index for Slack/context extraction, but Apple Notes is the user-facing source of truth for the todo list.
- User can create/install a private internal Slack app if needed.
- User can provide connections/permissions if needed.
- Local encrypted SQLite cache is preferred for Slack/context indexing.

## Privacy / Storage

- User likes local encrypted SQLite cache.
- Prefer privacy-preserving local storage; avoid leaking raw content to logs/dashboard.

## Apple Notes Todo Source of Truth

- Canonical note name: `Alfred Todo`.
- Format:

```md
# Today

## Must Do
- [ ] ...

## Should Do
- [ ] ...

## Waiting / Follow-up
- [ ] ...

## Later
- [ ] ...
```

- Alfred should read and update this note while preserving user edits where possible.
- Alfred should propose extracted todo candidates before writing unless the user later grants an explicit auto-update permission.

## Remaining Clarifications

1. For meeting awareness, first try non-invasive signals. If unreliable, ask the user before requesting macOS Accessibility permission to inspect Zoom/Slack window/activity state.
