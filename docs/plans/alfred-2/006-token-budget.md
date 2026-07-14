# 006 - Token Budget & Observability

## Goal

Track and report token usage for every Alfred 2.0 interaction. Show how many tokens were saved by context pre-injection, how many the LLM call consumed, and the total cost. Make the system's efficiency visible.

## Dependencies

- Requires: 001 (context), 002 (agent)
- Blocks: 007

## Scope

**In scope:**
- Token counting: use tiktoken or simple character-based estimate (4 chars ≈ 1 token)
- Track three categories per request:
  - **Context tokens:** tokens in the pre-injected "STATE OF YOUR SYSTEM" block
  - **LLM tokens:** tokens consumed by the LLM call (prompt + completion, from API response if available)
  - **Saved tokens:** estimated tokens that would have been spent on discovery commands if context wasn't pre-injected
- Display token report after each `/alfred` interaction (compact one-liner)
- Token budget warning: if a single interaction exceeds 10,000 tokens, warn the user
- Session token tally: track total tokens used in this pi session
- `/alfred token report` — show session totals

**Out of scope:**
- Cost estimation in dollars (depends on model pricing, add later)
- Token usage graphs or history
- Per-workspace token breakdown

## Checklist

- [ ] Implement `estimateTokens(text: string): number` — simple heuristic: `Math.ceil(text.length / 4)`
- [ ] Implement `TokenBudget` class: tracks context tokens, LLM tokens, saved tokens per request
- [ ] Compute saved tokens: count of discovery commands avoided (7) × estimated tokens per command (500 avg)
- [ ] Extract LLM token usage from API response `usage.prompt_tokens` and `usage.completion_tokens` when available
- [ ] Display compact token report after each response: `[ctx: 800 | llm: 3.2k | saved: 3.5k]`
- [ ] Session tally: accumulate totals across all `/alfred` calls in this pi session
- [ ] `/alfred token report` → display session totals with breakdown
- [ ] Token warning: if single request > 10,000 LLM tokens, show `[⚠ token budget: 12.4k]`
- [ ] Add test: context block of 2KB → estimateTokens returns ~500
- [ ] Add test: token report after 3 interactions shows accumulated totals
- [ ] Add test: saved tokens calculation is reasonable (3,500 ± 500 for typical setup)

## Tests

- [ ] Run `node --test --experimental-strip-types test/alfred-2/tokens.test.ts` — all pass
- [ ] Manual: `/alfred what PRs are open` → verify token report shows context tokens + LLM tokens + saved tokens

## Completion Criteria

- [ ] Every `/alfred` interaction reports token usage in a compact one-liner
- [ ] Saved tokens clearly show the value of context pre-injection
- [ ] Session tally accumulates correctly across multiple calls
- [ ] Token budget warnings fire for large interactions
- [ ] `/alfred token report` shows meaningful session totals

## Notes

- The token report is a key UX differentiator. It proves to the user that context pre-injection isn't just architectural — it's measurably saving money and latency.
- Default saved-token estimate: 7 discovery commands × 500 tokens each = 3,500 tokens saved per interaction. Actual savings depend on how verbose cmux/git output is.
- If the LLM API returns `usage` in the response, use exact numbers. Fall back to estimates otherwise.
- The token report should be unobtrusive — a dim line at the end of the response, not a headline.
