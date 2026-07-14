# 002 — Active Work & Meeting Awareness

Canonical details: `IMPLEMENTATION.md#002--active-work--meeting-awareness`.

## Goal

Give Alfred enough local context to know whether the user is actively working and whether now is a bad time to interrupt.

## Scope

**In scope:**

- Fail-closed idle/activity sampling.
- Active-work accumulation for break timing.
- Fuzzy Zoom/Slack huddle meeting state.
- Runtime state consumed by the proactive interruption policy.

**Out of scope:**

- Calendar integration.
- Screen recording.
- Keylogging.
- Persistent activity surveillance.
- Requesting Accessibility permissions without explicit user approval.

## Required Types

```ts
type MeetingState =
  | "in_meeting"
  | "maybe_in_meeting"
  | "not_in_meeting"
  | "unknown";
```

Meeting state must not be represented as a boolean. Probes are heuristic and can fail or produce weak evidence.

## Sampler Constants

These are fixed MVP constants, not user-configurable settings:

```ts
const SAMPLE_INTERVAL_MS = 30_000;
const IDLE_THRESHOLD_S = 60;
const IMPLICIT_BREAK_IDLE_S = 30 * 60;
const MAYBE_MEETING_PAUSE = true;
```

## Activity Semantics

- Active work means real activity, not merely computer awake.
- Use non-invasive idle signals first, e.g. macOS idle seconds via safe `execFile` probe.
- Sample every 30 seconds.
- Idle seconds `< 60` means active; idle seconds `>= 60` means not active.
- If the activity probe fails, returns malformed output, or times out, treat activity as `unknown`/inactive.
- Do not advance active-work accumulation on failed/unknown samples.
- Each successful tick contributes at most 30 seconds to active-work accumulation; late/missed ticks must not inflate count.
- Pause active-work accumulation during both `in_meeting` and `maybe_in_meeting`.
- If a break reminder is pending and the user is idle for >= 30 continuous minutes, treat that as implicit break acknowledgement and reset the break timer.

## Meeting Awareness Semantics

- Start with least-invasive signals: process/app state, frontmost app if available without extra permission, and other local non-invasive hints.
- Zoom and Slack huddle detection should return state plus evidence/confidence.
- Probe failure returns `unknown`, not `not_in_meeting`.
- Ask before requiring macOS Accessibility permission.
- Speech is suppressed during `in_meeting`, `maybe_in_meeting`, and `unknown`; meeting uncertainty should not produce speech.

## Runtime State Flow

Use a pull model:

- `activity/sampler.ts` owns a module-level `ActivityState` singleton.
- It exports `getSnapshot(): ActivityStateSnapshot` returning a copy of current state.
- Proactive policy calls `getSnapshot()` when deciding delivery and merges that with server-owned mute state.
- Avoid pub/sub for MVP.

## Checklist

- [ ] Add `src/alfred-2/activity/` modules for types, idle probe, meeting probes, and sampler.
- [ ] Add active-work accumulator that only increments on positive active samples, max 30 seconds per tick.
- [ ] Add module-level `ActivityState` with `getSnapshot()`.
- [ ] Add implicit break acknowledgement after 30 continuous idle minutes while break is pending.
- [ ] Add Zoom detection probe with `MeetingState` output.
- [ ] Add Slack huddle detection probe with `MeetingState` output.
- [ ] Feed activity/meeting state into proactive policy runtime state.
- [ ] Expose current activity/meeting state in the secured dashboard.
- [ ] Add tests for active-work accumulation, max-tick contribution, idle pause at 60s, probe failure fail-closed behavior, maybe-meeting pause, implicit break acknowledgement, meeting state uncertainty, and meeting suppression.

## Completion Criteria

- [ ] Alfred can distinguish 90 minutes of active work from a computer simply being awake.
- [ ] Alfred does not speak wellness/stuck nudges during known meetings/huddles.
- [ ] Probe failures do not cause false “active” or false “not in meeting” states.
