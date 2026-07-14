# 001 - Capability Inventory & Tool Contract

## Goal

Define the exact pi-like capabilities Alfred should support now and the stable tool-call contract the LLM will use to access them.

## Dependencies

- Requires: None
- Blocks: 002, 003, 005, 006, 007, 008

## Scope

**In scope:**
- Document first-phase tools: `bash`, `read_file`, `write_file`, `edit_file`, `web_search`, `fetch_content`, `ci_status`, `ci_logs`, and final speech.
- Define one compact JSON protocol for LLM turns: either a tool call or a final speech response.
- Define common tool result shape: success flag, text output, structured data, display summary, truncation metadata, retryability, and safety metadata.
- Define execution context fields: `requestId`, `toolCallId`, `cwd`, `workspaceRef`, `timeoutMs`, and `risk`.
- Define workspace/cwd resolution using `workspace-resolution.md`: cmux is source of truth for where, conversation memory is source of truth for what, Alfred repo is never implicit fallback.
- Define session accounting fields: `sessionId`, cumulative estimated/provider-reported total tokens, warning threshold, handoff threshold, and last handoff time.
- Define token counting as cumulative input + output tokens across every LLM call in the Alfred session, including system prompt/context/tool definitions/tool results for each turn. Use provider-reported usage when available; estimate otherwise.
- Define confirmation contract: pending tool call id/hash, expiry, exact payload to execute, deterministic preview, and user confirmation path.
- Define per-tool risk levels and confirmation requirements using `operational-decisions.md`.
- Define display surface contract: concise `speech`, detailed `displayText`, short macOS notification, developer logs.
- Adopt non-user-preference implementation defaults from `implementation-defaults.md` for Exa, parser retry prompt, session boundaries, confirmation TTLs, config paths, aliases, redaction, and tests.
- Document explicitly deferred tools: subagents, intercom, vision/video analysis, and long-running autonomous workers.

**Out of scope:**
- Implementing tool execution.
- Enabling the new prompt in production before the parser and loop exist.
- Changing Wispr Flow integration.

## Checklist

- [x] Create `src/alfred-2/tool-types.ts` with TypeScript interfaces for tool calls/results/context/risk.
- [x] Add `workspace-resolution.md` rules to the formal tool contract.
- [x] Add `operational-decisions.md` rules to the formal tool/safety/display contract.
- [x] Add `implementation-defaults.md` values to the formal config/session/parser/defaults contract.
- [x] Implement the deterministic parser behavior defined in `parser-contract.md` for final speech vs tool call JSON.
- [x] Document the tool protocol in `docs/plans/alfred-autonomous-tool-agent/tool-contract.md` or equivalent.
- [x] Decide max tool rounds, total timeout budget, per-tool output limits, and risk levels.
- [x] Define session token policy: cumulative input+output tokens, warn/prep handoff at ~80k tokens, require handoff at 100k tokens, use provider-reported usage when available and estimates otherwise.
- [x] Add `context-model.md` rules to the formal context contract: compact per-request cmux state, cached full help, on-demand detailed references.
- [x] Draft updated `agent.ts` prompt language, but do not enable it until 003.
- [x] Add tests for parsing valid tool calls and rejecting malformed/ambiguous tool calls.

## Tests

- [x] Run `node --test --experimental-strip-types test/alfred2-tool-types.test.ts`.
- [x] Run `npm run check`.

## Completion Criteria

- [x] Tool protocol is documented and represented in TypeScript.
- [x] Parser contract covers `<think>` blocks, code fences, pre/post prose, malformed JSON, schema-invalid JSON, and unknown tools.
- [x] Alfred can deterministically distinguish final speech from tool calls.
- [x] Tool calls include enough context to avoid running in the wrong repo/workspace.
- [x] The contract explicitly states Alfred's process cwd/repo is never the default target unless the user names Alfred.
- [x] Session token accounting and 100k handoff behavior are defined before memory/tool-loop implementation.
- [x] Confirmation semantics are defined before any mutating tools are added.
- [x] Display surfaces, provider strategy, parser retry prompt, session boundary, confirmation expiry, config paths, secret redaction, test discovery, and cmux context model are defined before implementation.
- [x] Deferred capabilities are recorded so future autonomy can extend the same contract instead of replacing it.

## Notes

- This task is intentionally design-heavy. The protocol should be simple enough for DeepSeek to emit reliably.
- Prefer one JSON object per LLM turn: `{ "speech": "..." }` or `{ "tool": "...", ... }`.
- Avoid OpenAI function-calling until proven necessary; plain JSON is easier to keep provider-compatible with DeepSeek.
- The 100k limit is a continuity/safety threshold, not a cost-saving measure. We can use generous context; we just need a reliable point to generate a handoff before the session becomes unwieldy.
