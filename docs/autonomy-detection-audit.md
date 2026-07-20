# Autonomy Detection and Control Audit

Status: remediation in progress

## Goal

Make Alfred's autonomous behavior understandable, explicitly scoped, conservative, and testable. Detection, authorization, execution, and UI reporting must remain separate concepts.

## Current model

Alfred currently has several independent autonomy mechanisms:

1. Alfred 2 `autoConfirm`, toggled by natural-language phrase matching.
2. Session monitors with `replyMode: "draft" | "send"`.
3. Daemon loops authorized by the `loop.autonomousSend` capability.
4. The Work Advisor, which autonomously samples a cmux surface and classifies work.
5. Scheduled reminders and work reviews.

The dashboard currently compresses these into an `Autonomous` or `Guarded` label even though they have different scopes and safety rules.

## Remediation checklist

### P0 — Safety and correctness

- [x] Protect every mutating local API with consistent loopback-origin, JSON content-type, and request-size checks.
- [x] Prevent the scheduled-job API from bypassing the same confirmation contract used by the agent tool.
- [x] Make Work Advisor fail closed unless it can identify the exact selected workspace and exact selected surface.
- [x] Consume a scheduled work review only after a defined successful outcome; preserve retryable/suppressed work.
- [x] Do not reinterpret persisted work-review jobs as ordinary reminders when Work Advisor is disabled.
- [x] Add a bounded recurrence range and validate date arithmetic before persistence or rescheduling.
- [x] Isolate failures per scheduled job so one malformed job cannot block later due jobs.
- [x] Reject locale-dependent and date-only schedule timestamps; require an explicit ISO timestamp with timezone.
- [x] Enforce non-mutating spoken Work Advisor advice in code rather than relying only on the model prompt.

### P1 — Detection quality and privacy

- [x] Base stuck/failing classification on temporal observations, not one static terminal snapshot.
- [x] Require genuinely separate polls before stuck/failing delivery.
- [x] Include screen-change/runtime evidence while treating unchanged text, dirty git, and elapsed time as insufficient alone.
- [x] Keep raw terminal text ephemeral and strengthen outbound secret redaction.
- [x] Make autonomous Work Advisor observation opt-in and scoped to an explicit workspace/workstream.
- [x] Ensure dedupe and cooldown keys remain stable when the model paraphrases advice.
- [x] Map confidence and verdict kind to appropriate delivery priority instead of marking every suggestion important.
- [x] Track actual delivery channels so failed/suppressed speech does not consume speech quotas or cooldowns.
- [ ] Clearly expose meeting and microphone uncertainty; do not claim Slack huddle detection when it is unavailable.

### P1 — Authorization and UX

- [x] Replace the broad `Autonomous` label with explicit execution posture and active autonomous capabilities.
- [x] Keep posture visible when approvals are pending.
- [x] Use a typed API for dashboard posture changes instead of sending English phrases through `/ask`.
- [x] Remove ambiguous phrases such as bare `go ahead` from global posture enablement.
- [x] Decide and document persistence/lifetime for posture grants.
- [ ] Scope grants to the smallest useful entity: session, monitor, loop, target, and action type.
- [x] Show autonomous-send monitors and capability-authorized daemon loops separately from edit auto-approval.

### P1 — Programmer model

- [x] Centralize confirmation behavior so `autoConfirm` eligibility is part of risk policy, not a second hard-coded tool-name list.
- [x] Make unknown/unregistered runtime tool calls fail closed.
- [ ] Replace planner substring/flag heuristics with typed action capability checks where possible.
- [x] Document the different authorization models used by Alfred 2 monitors and daemon loops.
- [x] Add contract tests proving privileged actions remain confirmation-gated under auto-confirm.

### P2 — Product limitations

- [ ] Improve Slack huddle detection only with an explicitly approved, privacy-preserving signal.
- [ ] Distinguish active work, passive activity, meetings, and unrelated keyboard/mouse activity.
- [ ] Add dashboard diagnostics showing which signals produced or suppressed a proactive verdict.

## Implementation progress

Completed in the first remediation pass:

- Local mutation APIs now enforce loopback-origin checks, bounded JSON bodies, and JSON media types.
- Direct scheduled-job creation now produces an immutable pending confirmation rather than executing immediately.
- Confirmations authorize one stored payload once; follow-on model actions return to the normal policy gate.
- Schedules use strict RFC3339 timestamps, bounded recurrence, constant-time advancement, per-job failure isolation, and observable attempt state.
- Scheduled work reviews retain exact workspace/surface scope and disclose LLM terminal transmission in their confirmation preview.
- Work Advisor requires an exact selected surface, compares temporal screen metadata, requires separated stuck/failing samples, uses stable dedupe, and never autonomously speaks model-authored advice.
- Background Work Advisor observation requires an explicit workspace grant and is shown in the dashboard.
- Active microphone use suppresses proactive speech; work-awareness speech also fails closed when microphone state is unknown.
- Routine-mutation auto-approval is centralized in risk policy, changed through a typed session API, and reported separately from autonomous-send monitors and daemon loops.

Remaining follow-up is intentionally visible in unchecked items below, especially richer meeting/activity signals, finer daemon per-loop grants, and replacement of legacy planner heuristics.

Validation after the first pass: `pnpm run check` passes with 470 Node tests and 10 web tests; `git diff --check` passes.

## Acceptance criteria

- A user can tell exactly which autonomous capabilities are enabled and for what scope.
- Conversational approval cannot silently broaden future permissions.
- A watcher never reads a guessed terminal surface.
- A single terminal screenshot cannot produce a stuck/failing interruption without a later independent observation.
- Scheduled jobs are either delivered, explicitly completed, or retained with an observable retry/suppression state.
- All mutation paths enforce the same safety policy regardless of whether they originate from voice, dashboard, or direct API use.
- Model output cannot directly create dangerous spoken instructions or bypass typed authorization.
- Tests cover false positives, false negatives, unavailable signals, restart behavior, and cross-surface ambiguity.

## Initial implementation order

1. API and scheduling safety.
2. Exact-target and temporal Work Advisor detection.
3. Central confirmation/autonomy policy.
4. Typed posture API and dashboard terminology.
5. Privacy, delivery accounting, and diagnostics.
6. Optional meeting/activity signal improvements.
