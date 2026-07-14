# 003 — Wellness Watchers

Canonical details: `IMPLEMENTATION.md#003--wellness-watchers`.

## Goal

Add gentle proactive break and meal reminders that account for actual active work, mute, cooldowns, and meeting/huddle state.

## Scope

**In scope:**

- Break watcher.
- Lunch watcher.
- Dinner watcher.
- Snooze/acknowledgement state.
- Integration with active-work state and proactive interruption policy.
- Dashboard controls after server/dashboard security is addressed.

**Out of scope:**

- Nutrition tracking.
- Health metrics integrations.
- Calendar-aware meal scheduling.

## User Decisions

- Break reminder: every 90 minutes of active work.
- Lunch: around 2–3pm.
- Dinner: around 8–9pm if still working.
- Speak only when appropriate/important; otherwise notify/dashboard.
- Tone: gentle and lightly funny.

## Constants

These are fixed MVP constants:

```ts
const BREAK_THRESHOLD_MINUTES = 90;
const SNOOZE_DEFAULT_MINUTES = 20;
const LUNCH_WINDOW = { start: 14, end: 15 };
const DINNER_WINDOW = { start: 20, end: 21 };
const MEAL_ACTIVE_IDLE_S = 120;
```

## Break Timer Rule

Do **not** reset the active-work timer immediately when the watcher emits a break event.

Reset only when:

- the user acknowledges/dismisses the break;
- the user snoozes the break;
- speech or notification was actually delivered successfully.

Successful delivery means:

- TTS call returns without throwing and the system was not muted at execution time.
- Notification delivery returns without throwing.
- If both speech and notification fail, do not reset.

If mute, meeting state, cooldown, or delivery failure suppresses the reminder, keep it pending/eligible rather than pretending the user took a break.

If a break reminder is pending and the user becomes idle for >= 30 continuous minutes, treat that as implicit acknowledgement and reset the timer.

## Meal Reminder Rules

- Lunch fires on the first 30-second tick inside 2–3pm where `idleSeconds < 120`.
- If the whole lunch window passes with `idleSeconds >= 120` on every check, lunch does not fire that day.
- Dinner fires on the first qualifying tick inside 8–9pm where both are true:
  - `activeWorkAccumulatedMinutes > 0` since the last accumulator reset;
  - `idleSeconds < 120`.
- Meal `firedToday` state resets at midnight, not daemon restart.
- Persist meal last-fired dates in local Alfred state so daemon restart does not re-fire a meal that already fired today.

## Example Speech

- “Sir, you’ve been at it for about ninety minutes. A short reset may be cheaper than brute force.”
- “Tiny butlerly observation, sir: lunch is looking overdue.”
- “Dinner may be worth defending, sir. The code will still be dramatic afterward.”

## Checklist

- [ ] Implement `src/alfred-2/watchers/wellness.ts`.
- [ ] Implement break watcher using active-work accumulation from 002.
- [ ] Implement default 20-minute snooze.
- [ ] Implement lunch watcher for 2–3pm window using `idleSeconds < 120`.
- [ ] Implement dinner watcher for 8–9pm window using accumulated-work + current idle checks.
- [ ] Persist meal last-fired dates across daemon restart.
- [ ] Add snooze/ack commands: “snooze break”, “remind me in 20”.
- [ ] Route every event through proactive interruption policy.
- [ ] Add dashboard controls only after security prerequisite.
- [ ] Add tests for timing windows, active-work threshold, meal current-activity checks, persisted meal fired dates, fail-closed activity, mute, meeting downgrade, cooldowns, default snooze, implicit idle acknowledgement, delivery-success reset, and no reset on suppressed emit.

## Completion Criteria

- [ ] Alfred feels helpful, not naggy.
- [ ] Wellness reminders only happen when the user has actually been working.
- [ ] Suppressed reminders do not silently reset break state.
