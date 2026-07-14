# 006 - Web Search & Content Fetching

## Goal

Give Alfred current external knowledge through configured web search and readable content fetching.

## Dependencies

- Requires: 001, 003
- Blocks: 009

## Scope

**In scope:**
- Add `web_search` tool for search queries using Exa as the initial/default provider when `EXA_API_KEY` is configured, following `implementation-defaults.md` result limits and content behavior.
- Add `fetch_content` tool for URLs with simple readable text extraction first; defer heavier readability dependencies unless needed.
- Implement the provider scope from `operational-decisions.md`: Exa direct API first. Other providers are deferred behind the same contract.
- Support provider configuration through environment variables.
- Fail gracefully when no search provider is configured; do not pretend raw `curl` is equivalent to search.
- Add prompt guidance: use web search when the answer depends on current or external knowledge.

**Out of scope:**
- Full browser automation.
- Vision/video frame analysis.
- Perfect citation formatting in speech; display text may include links.
- Depending on pi's internal `web_search` tool from the standalone Alfred server.

## Checklist

- [x] Implement Exa direct API using raw `fetch`, `EXA_API_KEY`, default 5 results, and max 10 results.
- [x] Document that Perplexity, Brave, Tavily, SearXNG/local, and Gemini are deferred until needed.
- [x] Implement `web_search(query, numResults?)` with timeout and result truncation.
- [x] Implement `fetch_content(url)` using Exa content retrieval when available, otherwise plain HTTP + simple readable text extraction.
- [x] Add env var documentation for `EXA_API_KEY` and deferred provider fallbacks.
- [x] Add prompt examples for weather/news/docs/current facts.
- [x] Ensure spoken output stays concise while display text can include sources.

## Tests

- [x] Add unit tests with mocked search/fetch responses.
- [x] Add test: no provider configured returns a graceful tool error.
- [x] Add test: fetched HTML is truncated/extracted safely.
- [x] Manual: ask current-info query and verify Alfred searches instead of guessing.
- [x] Run `npm run check`.

## Completion Criteria

- [x] Alfred can answer current external questions by using Exa when `EXA_API_KEY` is configured.
- [x] If no provider is configured, Alfred returns a graceful tool error instead of pretending curl is search.
- [x] Alfred can summarize a URL's readable contents.
- [x] Search failures do not crash the request and are explainable to the user.

## Notes

- This is the largest practical gap between Alfred and pi today, but provider choice must be explicit before coding.
