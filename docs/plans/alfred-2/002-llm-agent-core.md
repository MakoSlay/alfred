# 002 - LLM Agent Core

## Goal

Build the core LLM agent loop: take user text + pre-injected context, call an OpenAI-compatible LLM with bash/read/write tools, parse the response into speech + optional command, and return both.

## Dependencies

- Requires: 001 (context pre-injection)
- Blocks: 003, 004, 006

## Scope

**In scope:**
- `createAlfredAgent(config)` factory function: takes LLM endpoint, model, API key, system prompt
- `agent.ask(userText, context)` method: sends user text + context to LLM, returns `{ speech, command?, thinking? }`
- LLM call uses OpenAI-compatible `/chat/completions` (same as Alfred 1.x planner)
- Tools available to the LLM: `bash` (run shell commands), `read` (read files), `write` (write files)
- Tool definitions follow OpenAI function-calling format
- LLM can call tools, agent executes them, results fed back to LLM for final response
- Max 3 tool call rounds per request (prevents infinite loops)
- Timeout: 30s total per `ask()` call
- System prompt: describes Alfred's persona (butler, concise, helpful) + lists available tools + includes "STATE OF YOUR SYSTEM" block
- Response parsing: extract `speech` (text to speak) and optional `command` (bash command that was or will be executed)
- Streaming support: stream LLM response for faster perceived response (optional, can add later)

**Out of scope:**
- Multi-turn conversation memory (add later, simple context injection handles most cases)
- Vision (no image input to LLM yet)
- Tool definitions beyond bash/read/write
- Custom LLM providers beyond OpenAI-compatible

## Checklist

- [ ] Implement `createAlfredAgent()` in `src/alfred-2/agent.ts`
- [ ] Implement OpenAI-compatible chat completion call with function-calling tools
- [ ] Define `bash`, `read`, `write` tools in OpenAI function-calling format
- [ ] Implement tool execution loop: LLM requests tool → agent runs it → result fed back → LLM responds
- [ ] Enforce max 3 tool call rounds; if exceeded, return partial results with warning
- [ ] Enforce 30s total timeout per `ask()` call
- [ ] Build system prompt: persona + tool descriptions + safety rules + "STATE OF YOUR SYSTEM" placeholder
- [ ] Parse LLM final response: if it contains a `speak` function call, extract speech text; if it contains text, use as speech
- [ ] Handle LLM errors gracefully: timeout → "I'm having trouble reaching my brain."; API error → "My brain is unavailable right now."
- [ ] Reuse Alfred 1.x's `AlfredLlmPlannerConfig` for endpoint/model/key configuration
- [ ] Support same env vars: `ALFRED_LLM_ENDPOINT`, `ALFRED_LLM_MODEL`, `ALFRED_LLM_API_KEY`
- [ ] Add test: agent calls bash tool, captures output, returns speech
- [ ] Add test: agent returns speech-only response (no tool calls)
- [ ] Add test: agent hits tool call limit, returns partial results
- [ ] Add test: agent handles LLM timeout gracefully
- [ ] Add test: agent handles invalid LLM response gracefully

## Tests

- [ ] Run `node --test --experimental-strip-types test/alfred-2/agent.test.ts` — all pass
- [ ] Manual: call agent with "what workspaces do I have", verify it reads context and answers without calling cmux

## Completion Criteria

- [ ] `agent.ask("open Chrome")` returns `{ speech: "Opening Chrome.", command: "open -a 'Google Chrome'" }`
- [ ] `agent.ask("what PRs are open")` reads pre-injected context, returns speech listing PRs, no bash calls
- [ ] Agent never calls `cmux workspace list` or `git status` because context already has it
- [ ] Agent handles errors gracefully without crashing the pi session
- [ ] Agent respects timeout and tool call limits

## Notes

- The LLM's system prompt must explicitly say: "You already know the system state from the STATE OF YOUR SYSTEM section below. Do not run discovery commands like `cmux workspace list` or `git status` — the information is already provided."
- Tool definitions should mirror pi's built-in tools: `bash` runs a shell command and returns stdout/stderr; `read` reads a file; `write` creates/overwrites a file.
- The agent does NOT execute commands directly. It returns the command in the response. The caller (pi extension) decides whether to execute or confirm first.
- This separation keeps the agent pure — it plans and reports, the extension executes and confirms.
