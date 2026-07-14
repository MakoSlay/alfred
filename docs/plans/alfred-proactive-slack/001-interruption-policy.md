# 001 — Proactive Interruption Policy

Canonical details: `IMPLEMENTATION.md#001--proactive-interruption-policy`.

## Goal

Create the shared policy that decides whether proactive watcher events should be stored, shown in the dashboard, notified, spoken, or converted into a draft action.

## Scope

**In scope:**

- Proactive event model and priority model.
- Delivery decision function.
- Global/per-kind cooldowns and dedupe.
- Meeting-aware downgrade hook.
- Redacted in-memory event history.
- Integration seam with Alfred 2 server-owned mute/speech/notification runtime state.

**Out of scope:**

- Individual watcher implementations.
- Slack API integration.
- Apple Notes integration.
- A separate mute singleton or separate proactive daemon.

## Architecture Requirements

- New code goes under `src/alfred-2/proactive/`.
- The policy receives mute state from `src/alfred-2/server.ts`; it does not own `mutedUntil`.
- Dashboard controls/state additions require the server/dashboard security prerequisite: `docs/plans/alfred-2-stabilization/002-server-dashboard-security.md`.

## Proposed Types

```ts
type ProactivePriority = "silent" | "low" | "normal" | "important" | "urgent";
type ProactiveDelivery = "store_only" | "dashboard" | "notification" | "speech" | "draft";
type MeetingState = "in_meeting" | "maybe_in_meeting" | "not_in_meeting" | "unknown";

type RuntimeInterruptionState = {
  muted: boolean;
  mutedUntil: string | null;
  meetingState: MeetingState;
  explicitAllowMeetingSpeech?: boolean;
  now: Date;
};

type CooldownState = {
  lastFiredAt: Map<string, number>;
  record: (event: ProactiveEvent) => void;
  isOnCooldown: (key: string, windowMs: number) => boolean;
};
```

## Cooldown Ownership

- `event-store.ts` owns cooldown state and the 200-event ring buffer because both are session-scoped in-memory state.
- `decideProactiveDelivery(event, runtime, cooldownState)` receives a read-only cooldown snapshot and must stay pure/testable.
- After policy returns, `event-store.ts` mutates cooldown state via `cooldownState.record(event)`.
- No other module mutates cooldown state.

Cooldown windows:

| Kind | Cooldown |
|------|----------|
| `wellness` | 90 minutes |
| `stuck_work` | 20 minutes |
| `slack_attention` | 0 / on-demand only |
| `todo` | 60 minutes |
| `global:speech` | 30 minutes |

## Delivery Rules

```ts
speech_allowed(event, runtime) =
  runtime.muted === false
  && runtime.meetingState === "not_in_meeting"
  && (not_on_cooldown(event) || event.priority === "urgent");
```

- Mute means mute: no speech and no interruptive proactive notifications while muted.
- Urgent events bypass cooldown only; they do **not** bypass mute or meeting-state suppression.
- No speech during `in_meeting`, `maybe_in_meeting`, or `unknown`.
- During `maybe_in_meeting`, allow notifications for important/urgent only.
- During `unknown`: wellness dashboard only; important/urgent stuck-work notification + dashboard; urgent Slack notification + dashboard; low/normal dashboard only.
- Slack speaks only if urgent, missed, likely forgotten, not muted, `meetingState === "not_in_meeting"`, and not previously surfaced.
- “Missed and likely forgotten” requires: older than 2 hours, `requiresAction === true`, `reviewed === false`, and never surfaced via notification/speech before.

## Checklist

- [ ] Define proactive event, priority, delivery, and runtime-state types.
- [ ] Add capped/redacted 200-event in-memory proactive event store.
- [ ] Add `CooldownState` in `event-store.ts`; only `event-store.ts` mutates it.
- [ ] Add `decideProactiveDelivery` with mute, meeting, cooldown, urgent, and Slack-specific behavior.
- [ ] Wire delivery to existing Alfred 2 `notify`/`speak` paths without duplicating mute state.
- [ ] Add dashboard/API state for recent proactive events only after security hardening.
- [ ] Enforce privacy storage rules: wellness/todo non-Slack may store messages; stuck-work and Slack store metadata only.
- [ ] Add tests for priority routing, mute suppression, urgent cooldown-only bypass, `maybe_in_meeting`/`unknown` suppression, Slack missed/forgotten gating, event cap eviction, cooldown ownership, redaction, and dedupe.

## Completion Criteria

- [ ] Watchers can emit events without each watcher owning interruption rules.
- [ ] Alfred can be proactive without becoming noisy.
- [ ] No duplicate mute/proactive singleton exists.
