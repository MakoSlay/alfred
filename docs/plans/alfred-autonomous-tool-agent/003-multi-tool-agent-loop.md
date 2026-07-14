# 003 - Multi-Tool Agent Loop

## Goal

Replace the current single bash-command follow-up with a bounded tool loop that can execute multiple tools before Alfred speaks the final answer.

## Dependencies

- Requires: 001, 002
- Blocks: 004, 005, 006, 007, 008, 009

## Scope

**In scope:**
- Add `runToolLoop()` in a new `src/alfred-2/tool-loop.ts` or equivalent.
- Add a small tool dispatcher map for registered tools; this is not the Alfred 1.x action registry.
- Support repeated LLM turns: user/context → tool call → tool result → next LLM turn → final speech.
- Use `parser-contract.md` for every LLM response; parser errors are loop events, not crashes.
- Support `bash` as the first real tool.
- Resolve execution context: selected workspace/cwd, timeout, request id, tool call id.
- Preserve existing `{ speech, command }` behavior as a compatibility fallback during migration.
- Enforce max rounds, total timeout, output curation/truncation, secret redaction, and graceful failure.
- Accumulate LLM usage metadata for every turn in the loop so session accounting can trigger handoffs.
- Record all tool calls/results in history.

**Out of scope:**
- Implementing all tools at once.
- Streaming responses.
- Background jobs.

## Checklist

- [x] Extract current bash execution and follow-up logic into a reusable tool loop.
- [x] Add a tool dispatcher with `bash` and final speech support.
- [x] Add workspace/cwd resolution exactly as defined in `workspace-resolution.md`: current cmux workspace is default; explicit tool fields can refine it; Alfred repo is never implicit fallback.
- [x] Implement configurable workspace alias resolution and simple normalized fuzzy correction as defined in `implementation-defaults.md`, including obvious speech errors such as `Maine` → `Main`.
- [x] Feed stdout/stderr/tool metadata back to the LLM after each tool call after applying output curation and best-effort secret redaction.
- [x] Accumulate provider-reported or estimated token usage per LLM turn.
- [x] Stop when LLM returns final speech, confirmation is required, max rounds is reached, or session handoff is required.
- [x] If 100k token handoff threshold is crossed mid-request, stop safely with a partial-result handoff that includes in-progress task state, completed tool calls, pending next step if known, and a short spoken notice.
- [x] Keep existing mute, notification, history, displayText, and destructive-command behavior working.
- [x] Add loop transcript to command history with compact summaries.

## Tests

- [x] Add test: one bash tool call then final speech.
- [x] Add test: two sequential bash tool calls then final speech.
- [x] Add test: max tool rounds reached returns a safe partial response.
- [x] Add test: legacy `{ speech, command }` still works.
- [x] Add test: unknown/unregistered tool name triggers one parser retry, then graceful failure if repeated.
- [x] Add test: command runs in the current cmux workspace cwd when no explicit workspace is named.
- [x] Add test: command never falls back to the Alfred repo unless user explicitly asks for Alfred.
- [x] Add test: fuzzy workspace correction resolves `Maine` to `Main` when unambiguous, and asks when ambiguous.
- [x] Add test: multi-turn tool loop reports cumulative input+output token usage.
- [x] Add test: crossing 100k mid-request generates handoff with in-progress task state and stops safely.
- [x] Run `npm run check`.

## Completion Criteria

- [x] Alfred can run at least two tools in one request.
- [x] Existing curl/open/cmux voice flows still work.
- [x] Tool failures are represented as tool results, not server crashes.
- [x] The loop is testable with a fake LLM sequence.

## Notes

- This is the architectural keystone. Do this before adding web/file/CI tools.
