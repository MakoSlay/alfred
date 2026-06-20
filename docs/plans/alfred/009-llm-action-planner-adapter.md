# 009 - LLM Action Planner Adapter

## Goal

Move Alfred daemon `/handle` beyond deterministic draft matching by adding a source-agnostic LLM/action planner adapter while preserving draft-confirm safety.

## Dependencies

- Requires: 008
- Blocks: 010

## Scope

Introduce planner interfaces and an initial adapter informed by the Pi-local Alfred LLM adapter, without making the daemon depend on Pi internals or claiming actions before cmux confirms them.

**In scope:**

- A planner interface that consumes `AlfredHandleRequest`, visible targets, policy, and source capabilities.
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

## Checklist

- [ ] Read the current Pi-local planner in `/Users/muhammadabdul/work/pi-smart-voice-notify/src/alfred-adapters/llm.ts` and its tests for reusable prompt/parse/safety ideas.
- [ ] Define a daemon-owned planner contract that returns validated proposed actions, not raw provider text.
- [ ] Define what request/context fields may be sent to a planner, with raw transcripts excluded by default and sensitive text redacted or summarized.
- [ ] Wire `/handle` to use the planner only after source capability checks and cmux target refresh.
- [ ] Convert planner send intents into pending drafts that require confirmation before execution.
- [ ] Reject or ignore malformed, direct-send, cross-target, or capability-missing planner output with structured events/errors that do not persist raw unsafe provider output.
- [ ] Preserve deterministic draft matching as a fallback and as a testable baseline.
- [ ] Add fixture-backed tests for prose-wrapped JSON, proposal salvage if retained, unsupported output, target ambiguity, and planner-input redaction.

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

- [ ] `/handle` can use a daemon-owned planner without Pi-specific request contracts.
- [ ] Every send-like planner output becomes a pending draft first.
- [ ] Bad planner output fails closed and is observable in daemon events/errors without storing raw unsafe provider text.
- [ ] Planner input excludes raw transcripts by default and applies explicit redaction/size limits to shared context.
- [ ] Deterministic matching still works when planner is unavailable.
- [ ] Standalone Alfred gates pass.

## Notes

- Keep daemon contracts source-agnostic: Pi, CLI, dashboard, and future voice/text clients should all call the same shape.
- Reuse hardening ideas from Pi-local Alfred, not Pi extension ownership.
- Do not claim an action happened until `cmux` send succeeds.

## Blockers

- Best started after 008 so live daemon smoke exists before planner behavior expands.
