# 004 - Conversation Memory Context

## Goal

Give Alfred enough recent conversational context to resolve follow-ups and feel continuous across voice requests, and generate handoffs before a session crosses 100k tokens.

## Dependencies

- Requires: 002, 003
- Blocks: 008, 009

## Scope

**In scope:**
- Add a sanitized recent-conversation formatter separate from raw command history.
- Prefer in-memory compact turn summaries; use persisted history only as a source for explicit history queries.
- Inject last N compact turns into system context as `RECENT CONVERSATION`.
- Store tool-loop summaries, tool names, target/workspace hints, and final outcomes.
- Track cumulative session token usage as input + output tokens across every LLM call in the session, using provider-reported usage where possible and estimates otherwise.
- Add deterministic commands for memory status, search, clear, and handoff if needed.
- Generate a compact continuation handoff when the session approaches/crosses the 100k token threshold using `implementation-defaults.md` filename/location/content defaults.

**Out of scope:**
- Vector memory.
- Long-term preference learning.
- Persisting full file/surface contents.
- Optimizing primarily for token cost; the goal is continuity and reliability, not minimizing spend.
- Blindly injecting stdout/stderr from history into future prompts.

## Checklist

- [x] Add `formatConversationForContext()` separate from raw command history formatting.
- [x] Add or adapt an in-memory ring buffer for sanitized recent turns.
- [x] Include recent user text, final speech, tools used, target/workspace hints, and short outcomes.
- [x] Inject last 5-10 turns into `fullContext` before the LLM call.
- [x] Add memory clear/status/handoff paths or document why command history search is sufficient.
- [x] Track session token usage and expose it in memory/status output.
- [x] Warn/prep handoff at ~80k tokens and require/generate handoff at 100k tokens.
- [x] Save handoffs to `~/.alfred/handoffs/` using the default session/request filename format.
- [x] Ensure sensitive stdout/stderr is excluded unless explicitly summarized as safe.

## Tests

- [x] Add test: recent turns are formatted compactly.
- [x] Add test: large stdout is excluded from memory context.
- [x] Add test: memory clear removes recent-turn context.
- [x] Add test: session token counter accumulates input + output usage per LLM call and triggers warning at ~80k and handoff at 100k.
- [x] Add test: generated handoff includes task overview, current state, recent decisions, files/tools touched, pending confirmations, and next steps.
- [x] Manual: `open Firefox` then `search for weather there` uses recent context when useful.
- [x] Run `npm run check`.

## Completion Criteria

- [x] Alfred can answer "what did I just ask?" and use recent task references.
- [x] Context stays compact and does not leak huge command outputs into prompts.
- [x] Persistent history and prompt memory are not accidentally treated as the same thing.
- [x] A fresh Alfred session can continue from the generated handoff without needing the entire prior conversation.

## Notes

- The current `history.ts` is useful but too raw to inject directly forever. Treat prompt memory as a sanitized projection.
- Handoff generation should be deterministic/structured enough to trust. Do not use an extra LLM polish pass initially; source data should come from recorded summaries, tool traces, and pending state.
