# 009 - LLM Action Planner Adapter

## Goal

Move Alfred daemon `/handle` beyond deterministic draft matching by adding a source-agnostic LLM/action planner adapter while preserving draft-confirm safety.

## Dependencies

- Requires: 008
- Blocks: 010

## Scope

Introduce planner interfaces and an initial adapter informed by the Pi-local Alfred LLM adapter, without making the daemon depend on Pi internals or claiming actions before cmux confirms them.

**In scope:**

- A planner interface that consumes `AlfredPlannerInput` built from `AlfredHandleRequest`, visible targets, policy, and source capabilities.
- A standalone adapter module that can later call the chosen local/remote LLM provider.
- Deterministic fallback behavior when no planner is configured or planner output is unsupported.
- Strict parsing/validation for proposed actions.
- Planner-input privacy rules that avoid raw transcript sharing by default and limit/redact context sent to a provider.
- Tests for safe draft proposals, unsupported action rejection, privacy/redaction boundaries, and no-success-before-confirmation behavior.

**Out of scope:**

- Autonomous loop execution.
- Long-term memory or transcript persistence.
- New direct-send shortcuts.
- Removing the existing Pi-local planner before daemon parity is proven.

## Interface Sketch

Task 009 should implement a daemon-owned planner seam close to this shape:

```ts
export interface AlfredPlannerInput {
  requestId: AlfredId;
  source: AlfredSource;
  inputText: string;
  currentWorkspaceRef?: AlfredRef;
  visibleTargets: AlfredTarget[];
  allowedCapabilities: AlfredCapability[];
  maxInputChars: number;
}

export type AlfredPlannerIntent =
  | { kind: "none"; reason?: string }
  | { kind: "draft_message"; targetRef?: AlfredRef; targetName?: string; message: string };

export interface AlfredPlannerResult {
  ok: boolean;
  intent?: AlfredPlannerIntent;
  errors?: AlfredError[];
  sanitizedInputSummary: RedactedText;
}

export interface AlfredPlanner {
  plan(input: AlfredPlannerInput): Promise<AlfredPlannerResult>;
}
```

Initial implementation rules:

- Do not call a provider directly from `src/daemon/index.ts`; inject/use an `AlfredPlanner` dependency.
- Do not store raw provider output in daemon events. Store only validated intent summaries and structured errors.
- Planner input must be built from request text, current refs, and target labels/refs only; raw transcripts/session files are excluded by default.
- Apply a size limit before planner calls. Start with `request.policy?.maxTranscriptChars` only as an upper-bound compatibility field, but do not include transcripts yet.
- Supported first output is `draft_message`; unsupported or direct-send-like output fails closed and deterministic matching remains fallback.

## Checklist

- [x] Read the current Pi-local planner in `/Users/muhammadabdul/work/pi-smart-voice-notify/src/alfred-adapters/llm.ts` and its tests for reusable prompt/parse/safety ideas.
- [x] Define a daemon-owned planner contract that returns validated proposed actions, not raw provider text.
- [x] Define what request/context fields may be sent to a planner, with raw transcripts excluded by default and sensitive text redacted or summarized.
- [x] Wire `/handle` to use the planner only after source capability checks and cmux target refresh.
- [x] Convert planner send intents into pending drafts that require confirmation before execution.
- [x] Reject or ignore malformed, direct-send, cross-target, or capability-missing planner output with structured events/errors that do not persist raw unsafe provider output.
- [x] Preserve deterministic draft matching as a fallback and as a testable baseline; planner augments but does not replace the existing deterministic parser.
- [x] Add fixture-backed tests for prose-wrapped JSON, proposal salvage if retained, unsupported output, target ambiguity, and planner-input redaction.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

If Pi-local planner code is touched during comparison or extraction, also run:

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

Manual smoke after 008 is complete:

```text
/alfred can you ask my power co session in this workspace to let me know what files i can delete now?
/alfred send that
```

## Completion Criteria

- [x] `/handle` can use a daemon-owned planner without Pi-specific request contracts.
- [x] Every send-like planner output becomes a pending draft first.
- [x] Bad planner output fails closed and is observable in daemon events/errors without storing raw unsafe provider text.
- [x] Planner input excludes raw transcripts by default and applies explicit redaction/size limits to shared context.
- [x] Deterministic matching still works when planner is unavailable.
- [x] Standalone Alfred gates pass.

## Notes

- Keep daemon contracts source-agnostic: Pi, CLI, dashboard, and future voice/text clients should all call the same shape.
- Reuse hardening ideas from Pi-local Alfred, not Pi extension ownership.
- Do not claim an action happened until `cmux` send succeeds.
- Existing deterministic daemon parsing in `resolveDraftIntent()` remains the fallback for known patterns and for planner-unavailable paths.

## Implementation Notes

- Added `src/planner/index.ts` with daemon-owned planner contracts, sanitized planner input construction, strict/prose-wrapped JSON parsing, direct-send rejection, and runtime validation for injected planner results.
- Wired `AlfredDaemonDependencies.planner` into `/handle` after source `world.read` checks and cmux target refresh. Deterministic draft parsing still runs first; no planner dependency preserves the existing no-action behavior.
- Planner `draft_message` intents resolve by `targetRef` or safely matched `targetName` and always go through the existing pending-draft creation path. No planner path calls cmux send directly.
- Planner inputs include sanitized request text, current workspace ref, source/capabilities, and sanitized visible target labels/refs/capabilities only. Target metadata/session fields and raw transcripts remain excluded.
- Unsupported, malformed, ambiguous, or direct-send-like planner output returns a no-action `/handle` response with structured errors/events. Provider raw output is not stored; error text is redacted before response/state persistence.

## Validation Evidence

- 2026-06-20: `npm run check` — passed (44 tests).
- 2026-06-20: `npm run typecheck` — passed.
- 2026-06-20: `npm test` — passed (44 tests).

## Blockers

_None currently._
