# Alfred Proactive Watchers — Canonical Implementation Plan

Status: planning only. Do not implement source changes from this document until explicitly asked.

This is the canonical plan for Alfred 2 proactive wellness, meeting awareness, Slack attention, semantic stuck-work detection, and the Apple Notes todo source of truth. It supersedes any older sketches that refer to top-level `src/watchers`, `src/slack`, `src/activity`, or a separate proactive daemon.

Resolved gap answers and amendments in this file are locked decisions with the same weight as the non-negotiable architecture corrections.

## Non-Negotiable Architecture Corrections

1. **Alfred 2 owns this system.** New code belongs under Alfred 2:

   ```txt
   src/alfred-2/proactive/
   src/alfred-2/activity/
   src/alfred-2/watchers/
   src/alfred-2/slack/
   src/alfred-2/notes/
   ```

   Tests should follow existing Alfred 2 naming, e.g. `test/alfred2-proactive-policy.test.ts`, not a separate top-level watcher suite.

2. **Do not create a second mute singleton.** `src/alfred-2/server.ts` already owns timed mute (`mutedUntil`, `/mute`, `/unmute`, `/mute/status`, dashboard state). Proactive policy receives mute state from the Alfred 2 runtime/server.

3. **Urgent does not bypass mute.** Urgent only bypasses cooldown. If muted, proactive events may be recorded in dashboard/event history but must not speak or send interruptive notifications.

4. **Meeting state is fuzzy, not boolean.** Use:

   ```ts
   type MeetingState =
     | "in_meeting"
     | "maybe_in_meeting"
     | "not_in_meeting"
     | "unknown";
   ```

5. **Activity detection fails closed.** If idle/activity probes fail, do not assume the user is active and do not advance active-work timers.

6. **Break reminders do not reset their timer merely because an event was emitted.** Reset only after user acknowledgement, snooze, or a verified successful delivery.

7. **Apple Notes execution must be safe.** Use `execFile("osascript", ["-e", script, ...args])` or an equivalent `execFile` form. Never shell-interpolate note content or todo text.

8. **Apple Notes parser and serializer must round-trip.** If serializer emits Notes HTML (`<h1>`, `<h2>`, `<div>- [ ] ...</div>`), parser must understand heading tags before stripping HTML. If serializer emits markdown-ish text, parser must parse that exact format.

9. **No fake empty checklist items.** Empty sections serialize as headings only; never emit `- [ ]` placeholders.

10. **Apple Notes updates must preserve manual edits.** Use read → hash → proposed patch → re-read before write → section/item-level merge. If merge is uncertain, ask instead of overwriting.

11. **Slack MVP is least-privilege.** Start with mentions, reminders, and explicit user asks where feasible. DMs/private channels, search, files/canvases, and broad history are opt-in phases only after API/scope verification.

12. **External LLM classification of Slack content is opt-in.** Default Slack triage is local/rule-based. On-demand summaries may use Alfred's LLM only when the user explicitly asks, and Slack content must not be silently sent to external LLM providers.

13. **Use the existing `LlmClient`.** Semantic stuck-work and optional summarization use `LlmClient` from `src/alfred-2/agent.ts`; do not hard-code Anthropic SDKs, models, or provider-specific clients.

14. **Stuck-work never uses process `pwd` as a fallback.** It must use the resolved cmux workspace/cwd provider already used by Alfred 2. If no workspace cwd is known, skip git/process analysis and report that the signal is unavailable.

15. **Dashboard/server security is a prerequisite for new controls.** Finish or honor `docs/plans/alfred-2-stabilization/002-server-dashboard-security.md` before adding proactive dashboard controls or Slack/Notes mutation endpoints.

## Locked User Decisions

- Alfred should speak for important things, but low-priority items should be dashboard/notification only.
- Wellness and stuck-work may speak only when important and appropriate.
- Slack stays silent unless urgent, missed, and likely forgotten.
- No fixed quiet hours for now.
- Tone: gentle, lightly funny butler; helpful, not bossy.
- Break cadence: 90 minutes of active work.
- Active work means actual user activity, not simply computer awake.
- Lunch window: around 2–3pm.
- Dinner window: around 8–9pm if still working.
- Meeting awareness covers Zoom meetings and Slack huddles.
- Stuck-work checks every 10 minutes and should be semantic/contextual.
- Alfred should distinguish active stuck work from stopped/incomplete work that the user may have intentionally switched away from.
- Nudging other chats/agents is draft-and-confirm by default; never auto-send by default.
- Slack attention prioritizes mentions, reminders, and contextual asks; DMs and all-unread do not automatically matter.
- Saved items/bookmarks are excluded from MVP attention.
- “Slack files” means Slack canvases, which are optional after API/scope verification.
- Apple Notes note name: `Alfred Todo`.
- Apple Notes is the user-facing todo source of truth; local encrypted SQLite may be used for Slack/context indexing.

## Implementation Order

Implement in this order:

```txt
001 → 002 → 003 → 006 → 005 → 004
```

Reasoning:

- `001` creates the shared delivery/interruption rules.
- `002` supplies activity and meeting state required by wellness.
- `003` delivers low-risk wellness value.
- `006` establishes the human-editable todo source before Slack populates it.
- `005` adds Slack ingestion/attention with privacy boundaries.
- `004` uses mature policy, activity, workspace, notes, and LLM seams for semantic stuck-work.

## Existing Alfred 2 Integration Points

Inspect and integrate with these existing files before coding:

- `src/alfred-2/server.ts` — HTTP routes, dashboard state, session state, mute, speech stripping, notification calls.
- `src/alfred-2/dashboard.ts` — dashboard rendering and client JS.
- `src/alfred-2/tool-loop.ts` — autonomous tool loop, workspace/cwd resolution, `LlmClient` usage, confirmation flow.
- `src/alfred-2/agent.ts` — `LlmClient` abstraction.
- `src/alfred-2/memory.ts` / `history.ts` / `profile.ts` — compact context and persistence patterns.
- `src/alfred-2/confirmation.ts` — preview/hash/TTL patterns for actions that need confirmation.
- `src/alfred-2/undo.ts` — safety pattern for reversible writes.

## Shared Runtime Model

Add proactive code that consumes server/runtime state instead of owning duplicate global state.

```ts
type ProactivePriority = "silent" | "low" | "normal" | "important" | "urgent";
type ProactiveKind = "wellness" | "stuck_work" | "slack_attention" | "meeting" | "todo";
type ProactiveDelivery = "store_only" | "dashboard" | "notification" | "speech" | "draft";

type MeetingState = "in_meeting" | "maybe_in_meeting" | "not_in_meeting" | "unknown";

type RuntimeInterruptionState = {
  muted: boolean;
  mutedUntil: string | null;
  meetingState: MeetingState;
  meetingEvidence?: string[];
  explicitAllowMeetingSpeech?: boolean;
  now: Date;
};

type ProactiveEvent = {
  id: string;
  watcherId: string;
  kind: ProactiveKind;
  priority: ProactivePriority;
  title: string;
  message: string;
  createdAt: string;
  dedupeKey?: string;
  sourceRefs?: Array<{ type: string; label: string; url?: string }>;
  suggestedAction?: { label: string; draftText?: string; requiresConfirmation: true };
  privacy: { mayStoreMessage: boolean; containsSlackContent?: boolean; containsTerminalContent?: boolean };
};

type CooldownState = {
  lastFiredAt: Map<string, number>;
  record: (event: ProactiveEvent) => void;
  isOnCooldown: (key: string, windowMs: number) => boolean;
};
```

Privacy storage rules:

- Wellness events: `mayStoreMessage: true`.
- Stuck-work events: `mayStoreMessage: false`.
- Slack events: `mayStoreMessage: false`.
- Todo proposal events not sourced from Slack: `mayStoreMessage: true`.
- When `mayStoreMessage: false`, store only metadata (`id`, `kind`, `priority`, `watcherId`, `createdAt`, `title`) and omit `message` from the ring buffer. The full message may still be used for the immediate delivery attempt.

### Delivery Policy

Delivery rules are locked and intentionally conservative.

```ts
speech_allowed(event, runtime) =
  runtime.muted === false
  && runtime.meetingState === "not_in_meeting"
  && (not_on_cooldown(event) || event.priority === "urgent");

notification_allowed(event, runtime) =
  runtime.muted === false
  && event.priority !== "low"
  && event.priority !== "silent";
```

- Mute means mute: no speech and no interruptive proactive notifications while muted. This applies even to urgent events.
- `urgent` bypasses cooldown only. It does **not** bypass mute, `in_meeting`, `maybe_in_meeting`, or `unknown` speech suppression.
- Speech is allowed only when `meetingState === "not_in_meeting"`.
- During `in_meeting`, suppress all speech. Important/urgent events may record to dashboard and notify only if notification rules allow.
- During `maybe_in_meeting`, suppress all speech regardless of priority; allow notifications for important/urgent only.
- During `unknown`, suppress all speech. Delivery is:
  - `wellness` any priority → `store_only`/dashboard only;
  - `stuck_work` important/urgent → notification + dashboard;
  - `slack_attention` urgent → notification + dashboard;
  - anything low/normal → dashboard only.
- Slack events may speak only when all are true: urgent, missed and likely forgotten, not muted, `meetingState === "not_in_meeting"`, and not on speech cooldown unless urgent bypass applies.
- “Missed and likely forgotten” means all four are true: item older than 2 hours, `requiresAction === true`, `reviewed === false`, and it has never previously been surfaced via notification or speech.
- Cooldowns are centralized in `event-store.ts`, not reimplemented per watcher.

## 001 — Proactive Interruption Policy

Create `src/alfred-2/proactive/`.

Suggested modules:

```txt
src/alfred-2/proactive/types.ts
src/alfred-2/proactive/policy.ts
src/alfred-2/proactive/event-store.ts
src/alfred-2/proactive/runtime-state.ts
```

Policy signature:

```ts
function decideProactiveDelivery(
  event: ProactiveEvent,
  runtime: RuntimeInterruptionState,
  cooldownState: CooldownState, // snapshot, read-only inside this function
): { deliveries: ProactiveDelivery[]; suppressReason?: string }
```

Checklist:

- Define shared event, priority, delivery, and runtime-state types.
- Add a capped 200-event in-memory event store with redaction for Slack/terminal content.
- Co-locate session-scoped `CooldownState` with the event ring buffer in `event-store.ts`.
- Keep `decideProactiveDelivery(event, runtime, cooldownState)` pure: it receives a read-only cooldown snapshot and returns deliveries/suppress reason; `event-store.ts` mutates cooldown state after policy returns.
- Use cooldown windows: wellness 90m, stuck_work 20m, slack_attention 0/on-demand, todo 60m, global:speech 30m.
- Persist privacy-safe event metadata according to `privacy.mayStoreMessage`; when false, store only `id`, `kind`, `priority`, `watcherId`, `createdAt`, and `title`.
- Wire delivery through existing server-owned `notify`/`speak` paths without duplicating mute state.
- Add dashboard state shape for recent proactive events only after dashboard security is addressed.
- Add tests for mute suppression, urgent cooldown bypass, meeting downgrade, Slack silence, redaction, and dedupe.

## 002 — Active Work & Meeting Awareness

Create `src/alfred-2/activity/`.

Fixed MVP constants:

```ts
const SAMPLE_INTERVAL_MS = 30_000;
const IDLE_THRESHOLD_S = 60;
const IMPLICIT_BREAK_IDLE_S = 30 * 60;
const MAYBE_MEETING_PAUSE = true;
```

These are not user-configurable in MVP.

Suggested modules:

```txt
src/alfred-2/activity/types.ts
src/alfred-2/activity/idle.ts
src/alfred-2/activity/meeting.ts
src/alfred-2/activity/sampler.ts
```

Checklist:

- Sample macOS idle time every 30 seconds with safe process execution (`execFile`) and no keylogging.
- Treat idle seconds `< 60` as active; idle seconds `>= 60` as not active.
- If idle sampling fails, return `unknown`/inactive; do not advance active-work accumulation.
- Each successful tick contributes at most 30 seconds to the accumulator, even if the sampler ran late.
- Track active-work accumulation from positive active samples only.
- Pause active-work accumulation during both `in_meeting` and `maybe_in_meeting`.
- `activity/sampler.ts` owns a module-level `ActivityState`; proactive policy pulls `getSnapshot()` at decision time and merges it with server-owned mute state.
- If a break reminder is pending and the user becomes idle for >= 30 continuous minutes, treat that as an implicit break acknowledgement and reset the break timer.
- Implement non-invasive Zoom and Slack huddle probes first: process state, app/frontmost state where available, audio/session hints if available without extra permission.
- Represent probe failures as `unknown`, not `not_in_meeting`.
- Ask before requesting Accessibility permissions; do not make Accessibility a silent dependency.
- Expose activity/meeting state to the dashboard only behind the secured dashboard controls.

## 003 — Wellness Watchers

Create `src/alfred-2/watchers/wellness.ts` and any shared watcher scheduler under `src/alfred-2/watchers/`.

Fixed MVP constants:

```ts
const BREAK_THRESHOLD_MINUTES = 90;
const SNOOZE_DEFAULT_MINUTES = 20;
const LUNCH_WINDOW = { start: 14, end: 15 };
const DINNER_WINDOW = { start: 20, end: 21 };
const MEAL_ACTIVE_IDLE_S = 120;
```

Checklist:

- Break watcher fires after 90 minutes of accumulated active work.
- Default snooze duration is 20 minutes.
- Lunch watcher fires once in the 2–3pm window on the first 30s tick where `idleSeconds < 120`; if no qualifying tick occurs, it does not fire that day.
- Dinner watcher fires once in the 8–9pm window only when `activeWorkAccumulatedMinutes > 0` since last accumulator reset and `idleSeconds < 120` at the check.
- Meal `firedToday` state resets at midnight, not daemon restart; persist last fired date in local Alfred state so restart does not re-fire meals.
- Route all events through the proactive policy.
- Implement acknowledgement/snooze state.
- Do **not** reset break active-work timer at event creation time.
- Reset break timer only when one of these is true:
  - user acknowledges the break;
  - user snoozes/dismisses it;
  - speech/notification delivery returns successful delivery.
- TTS delivery is successful only when the TTS call returns without throwing and the system was not muted at execution time.
- Notification delivery is successful when `notify()` returns without throwing.
- If both speech and notification fail, or policy downgrades to dashboard because of mute/meeting/unknown state, keep the break eligible or pending rather than pretending the user took a break.
- Add tests for active-work timing, fail-closed idle state, mute suppression, meeting downgrade, snooze, acknowledgement, delivery-success reset, and no reset on suppressed emit.

## 006 — Apple Notes Todo Source of Truth — Redesigned MVP

Create `src/alfred-2/notes/`, but keep Phase 1 deliberately small and safety-first.

### Phase 1 Goal

Let Alfred read the `Alfred Todo` note and append confirmed items to the agreed sections without corrupting manual edits. Do **not** build a full sync engine, fuzzy merge engine, or SQLite identity layer in Phase 1.

Suggested Phase 1 modules:

```txt
src/alfred-2/notes/apple-notes.ts
src/alfred-2/notes/todo-format.ts
src/alfred-2/notes/todo-actions.ts
```

Phase 1 rules:

- Use `execFile("osascript", ["-e", script, ...args])` or equivalent safe process execution. Never shell-interpolate note or todo content.
- Read `Alfred Todo`; create it only with confirmation.
- Parse the canonical markdown-ish checklist shape and the Notes HTML generated by Alfred's own serializer.
- Before implementing parser assumptions, capture a real Notes HTML fixture from this machine.
- Serialize only the simple canonical sections:
  - `Must Do`
  - `Should Do`
  - `Waiting / Follow-up`
  - `Later`
- Do not emit fake blank checklist items.
- Phase 1 writes are **append-only within a section**. Alfred does not edit, reorder, delete, check, uncheck, or rewrite existing user items.
- Write flow:
  1. Read latest note.
  2. Parse into structured sections.
  3. If parse fails, stop and ask the user; do not write.
  4. Show a confirmation preview for the append.
  5. Immediately before write, re-read latest note.
  6. Re-parse and append to the latest version.
  7. If re-parse fails or section structure is ambiguous, ask instead of writing.
- No SQLite `todo_item_map` in Phase 1.
- No fuzzy matching in Phase 1.
- Native Notes checklist parsing is follow-up unless the real fixture proves it is required for the user's existing note.
- Source refs may stay in Alfred's private event/cache metadata; do not embed IDs in the human note.

Phase 1 tests:

- safe `execFile` command shape;
- parse canonical sections;
- serialize round-trip for Alfred-owned canonical format;
- append to a section while preserving all existing item text/order;
- no fake blank items;
- conflict/re-read behavior;
- refusal when parse is ambiguous.

Deferred hardening:

- Native Notes checklist support beyond observed fixtures.
- SQLite item identity mapping.
- Fuzzy merge/edit preservation.
- Updating/checking/removing existing items.
- Shortcuts CLI fallback.

## 005 — Slack Attention — Redesigned MVP

Create `src/alfred-2/slack/`, but Phase 1 is an on-demand read-only prototype. Do not implement background polling, encrypted SQLite, `keytar`, or a Slack data warehouse in Phase 1.

### Phase 1 Goal

Answer a narrow question on demand: “what did I miss / what needs my attention?” using only verified Slack API capabilities and without persisting message content.

Suggested Phase 1 modules:

```txt
src/alfred-2/slack/client.ts
src/alfred-2/slack/scopes.ts
src/alfred-2/slack/attention.ts
src/alfred-2/slack/privacy.ts
```

Phase 1 rules:

- Read-only.
- On-demand only. No 15-minute poller in Phase 1.
- No Socket Mode in Phase 1.
- No SQLite cache in Phase 1.
- No `keytar` dependency in Phase 1.
- No external LLM classification by default.
- Token comes from env/local secure config and is redacted from logs, errors, dashboard state, and history.
- First implementation task is an API/scope spike: prove which scopes can answer human-user mentions and reminders. Do not assume `app_mentions:read` covers mentions of the human user.
- MVP scopes must be documented only after the spike. Until then, treat scope names as hypotheses.
- Slack results are ephemeral per request. Store only redacted high-level event metadata if routed through proactive policy.
- Contextual asks are rule-based and only considered from messages that already passed the verified attention-source filter.
- DMs/private channels/search/files/canvases remain follow-up and require explicit enablement.
- Slack todo extraction produces candidates only; Apple Notes writes still require confirmation and go through the Notes module.

Phase 1 tests:

- token redaction;
- scope/config failure modes;
- no raw Slack content persisted to event store/history/dashboard;
- rule-based attention ranking on fixture payloads;
- external LLM path disabled by default.

Deferred hardening:

- Background polling.
- Encrypted SQLite cache.
- `keytar` + AES-256-GCM per-field encryption.
- Retention jobs.
- DMs/private channels/search/canvases.
- On-demand LLM summarization with explicit privacy confirmation.

## 004 — Semantic Stuck/Stopped Work — Redesigned MVP

Create `src/alfred-2/watchers/stuck-work.ts`, but do not start with a generalized autonomous workstream intelligence platform.

### Phase 1 Goal

Provide conservative, opt-in detection for a watched workspace/workstream and distinguish:

- active but stuck;
- quiet/paused;
- stopped incomplete;
- urgent.

Phase 1 should produce dashboard/notification events and optional confirmed follow-up suggestions. It should not auto-nudge other agents.

Suggested Phase 1 modules:

```txt
src/alfred-2/watchers/stuck-work.ts
src/alfred-2/watchers/workstream-snapshot.ts
```

Phase 1 rules:

- Opt-in per workspace/workstream. No global always-on stuck watcher in Phase 1.
- Poll every 10 minutes only for explicitly watched workstreams.
- Use resolved cmux workspace/cwd only. Never use Alfred process `pwd` as fallback.
- If no cwd/workspace context exists, skip git/process analysis and mark that signal unavailable.
- Snapshot is small and recent only:
  - recent Alfred turns for this workstream;
  - last few tool results if available;
  - cmux workspace activity/change timestamps if available;
  - git/CI/PR signal only when cwd is known.
- Use existing `LlmClient` only for the compact verdict step. No provider-specific SDK.
- Store only verdict metadata/evidence summaries, not raw terminal/chat content.
- `userSwitchedAway` remains conservative: true only with cmux active-workspace evidence or a clearly classified different-workstream Alfred conversation; otherwise false.
- Alert threshold: 2 consecutive medium+ `stuck` or `urgent` verdicts from separate polls.
- Verdict mapping:
  - `progressing`, `quiet`, `paused_by_user` → silent/store only;
  - `stopped_incomplete` → low/dashboard + optional “Add to follow-up” suggested action;
  - `stuck` → important notification, possible speech only if policy allows;
  - `urgent` → urgent notification, still no speech when muted/in meeting/unknown.
- Stopped incomplete never speaks by default.
- Nudge other chats/agents is draft-and-confirm only and may be deferred entirely from Phase 1.
- Todo path is decoupled: emit `ProactiveEvent.suggestedAction`; confirmation flow calls Notes. Stuck watcher does not import/call Notes directly.

Phase 1 tests:

- no-cwd fail-closed behavior;
- stopped-vs-stuck verdict parsing;
- consecutive-verdict threshold;
- verdict-to-priority mapping;
- no raw content persistence;
- suggestedAction path for stopped incomplete;
- no auto-send/nudge by default.

Deferred hardening:

- Global workstream grouping across all chats.
- Sophisticated project/PR/survey/CSB inference.
- Auto-nudge grants.
- Rich dashboard controls.
- Long-term workstream memory.
## Validation Before Implementation Starts

For this planning pass, docs-only edits should at minimum run:

```bash
npm run typecheck
```

Before implementation PRs, run:

```bash
npm run check
```

Also inspect diffs:

```bash
git diff --stat
git diff -- docs/plans/alfred-proactive-slack docs/plans/alfred-2-stabilization
```

## Remaining Open Questions

1. **AppleScript vs Shortcuts for Notes writes.** Does the production machine run macOS 13+? If yes, Shortcuts CLI (`shortcuts run`) is an option for reliability. If unsure, default to AppleScript and document Shortcuts as a later fallback. Decision needed before 006 implementation.
2. **Accessibility permission for meeting detection.** Default is non-invasive detection. Suggested prompt timing: after about one week of use if Zoom/Slack huddle false-negative rate is high, especially if Alfred speaks during a known meeting. Not a blocker for 001–003.
3. **Future meeting override for urgent speech.** Current decision is no speech during any non-`not_in_meeting` state, regardless of priority. Track any “I’m not in a meeting” override as a deferred feature, not MVP.
