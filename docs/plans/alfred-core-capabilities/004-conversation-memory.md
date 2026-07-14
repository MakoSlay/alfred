# 004 - Conversation Memory

## Goal

Add ephemeral session-scoped conversation memory so Alfred remembers the last N exchanges and can use that context to resolve ambiguous references, track multi-turn tasks, and feel conversational rather than stateless.

## Dependencies

- Requires: 001 (read/summarize gives meaningful content to remember)
- Blocks: 005, 009, 010

## Scope

**In scope:**
- Add in-memory conversation store to daemon state (ring buffer, last 20 exchanges)
- Store per-exchange: requestId, input text, route taken (deterministic/planner), intent kind, resolved target, display text summary
- Feed recent conversation context into planner system prompt (last 5 exchanges as compressed context)
- Add `memory_search` planner intent: search recent conversation for a topic
- Add `memory_clear` intent: clear conversation memory
- Add `memory_status` intent: show how many exchanges are remembered
- Reference resolution: if user says `"what about the other tab"`, use conversation memory to infer which target was last discussed
- Planner prompt update: include recent conversation context in user prompt

**Out of scope:**
- Persistent memory across daemon restarts
- Long-term memory / vector storage
- Memory of file contents or surface contents (only exchange-level summaries)
- User identity or preference learning

## Checklist

- [ ] Define `ConversationMemory` interface and ring buffer implementation in new `src/memory/index.ts`
- [ ] Add `conversationMemory` to `DaemonState` and `AlfredDaemonDependencies`
- [ ] Store each exchange after daemon handles a request (requestId, input text, route, intent kind, target summary, display text)
- [ ] Build compressed conversation context (last 5 exchanges) in planner user prompt builder (`buildPlannerUserPrompt`)
- [ ] Add `memory_search`, `memory_clear`, `memory_status` to `AlfredPlannerIntent` union
- [ ] Add deterministic router patterns: `"what did I just ask"`, `"clear memory"`, `"what do you remember"`
- [ ] Add daemon test: two-turn exchange where second turn references first turn's target
- [ ] Add daemon test: `memory_search` returns recent relevant exchanges
- [ ] Add daemon test: `memory_clear` empties memory, subsequent reference fails gracefully
- [ ] Add daemon test: memory wraps correctly at ring buffer limit
- [ ] Add planner test: planner prompt includes conversation context when memory is non-empty

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/memory.test.ts` — all pass (new test file)
- [ ] Run `npm run check` — zero regressions

## Completion Criteria

- [ ] Alfred remembers the last 20 exchanges and can reference them
- [ ] Planner prompt includes compressed conversation context from last 5 exchanges
- [ ] Two-turn exchanges work: `"read the Powerco tab"` → `"summarize it"` resolves to Powerco
- [ ] `memory_search` finds relevant past exchanges by keyword
- [ ] `memory_clear` resets memory; subsequent commands work without stale context
- [ ] Memory does not persist across daemon restarts (ephemeral by design)
- [ ] All existing tests pass

## Notes

- Ring buffer with configurable size (default 20, env `ALFRED_MEMORY_SIZE`). Oldest entries evicted silently.
- Conversation context in planner prompt must be compressed: store only target label, intent kind, and a one-line summary per exchange. Never store full surface text or file contents.
- Privacy: memory is in-process only, never written to disk, cleared on daemon restart.
- `memory_search` uses simple keyword matching against stored exchange summaries. Not semantic search — keeps it fast and zero-dependency.
