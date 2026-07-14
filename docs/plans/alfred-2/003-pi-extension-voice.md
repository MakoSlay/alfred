# 003 - Pi Extension & Voice Wiring

## Goal

Build the pi extension that wires everything together: intercept `/alfred` commands, gather context, call the LLM agent, execute safe commands, speak responses, and show activity in pi's terminal.

## Dependencies

- Requires: 001 (context), 002 (agent)
- Blocks: 004, 005, 006, 007

## Scope

**In scope:**
- Pi extension source at `src/alfred-2/extension.ts` (in alfred repo), synced to `~/.pi/agent/extensions/alfred-2.ts` via existing `scripts/sync-to-live.sh` or similar
- Register `/alfred` slash command in pi
- On `/alfred <text>`: gather context → call agent → if command returned and safe → execute via pi's bash → speak response
- Display: show context gathering progress ("Scanning system..."), LLM thinking ("Thinking..."), command execution, and final speech in pi's output
- Speech: use pi's existing speech capability from the extension API
- Configuration: read `ALFRED_LLM_ENDPOINT`, `ALFRED_LLM_MODEL`, `ALFRED_LLM_API_KEY` from environment or settings
- Fallback: if agent fails, fall back to Alfred 1.x daemon (if running) or show error
- Coexistence: Alfred 1.x daemon and Alfred 2.0 extension both work; `/alfred` routes to 2.0 by default, with env flag to prefer 1.x

**Out of scope:**
- Wispr Flow integration (already works — Wispr Flow sends text to pi)
- Dashboard (Alfred 1.x handles this)
- Multiple simultaneous LLM calls
- Async/background agent runs

## Checklist

- [ ] Create `src/alfred-2/extension.ts` — pi extension entry point
- [ ] Register `/alfred` command that invokes the Alfred 2.0 agent pipeline
- [ ] Wire context gathering: on each `/alfred` call, await `gatherSystemContext()`, inject into agent
- [ ] Wire agent call: pass user text + context to `agent.ask()`, await response
- [ ] Display context gathering progress in pi output (one-line status: "Scanning 5 workspaces...")
- [ ] Display LLM thinking indicator ("Thinking...") during agent call
- [ ] If agent returns a safe command, display it and execute via pi's `bash` tool
- [ ] If agent returns a destructive command, route to confirmation guard (Task 004)
- [ ] Speech response: use pi extension API to speak the agent's `speech` text
- [ ] Configuration from env: read `ALFRED_2_ENABLED`, `ALFRED_LLM_ENDPOINT`, `ALFRED_LLM_MODEL`, `ALFRED_LLM_API_KEY`
- [ ] Fallback: if `ALFRED_2_ENABLED=false` or agent init fails, route to Alfred 1.x daemon
- [ ] Add test: extension loads without crashing
- [ ] Add test: `/alfred what targets are active` calls agent with context, returns speech
- [ ] Add test: extension falls back to 1.x daemon when 2.0 disabled

## Tests

- [ ] Run `node --test --experimental-strip-types test/alfred-2/extension.test.ts` — all pass
- [ ] Manual: `/alfred open Chrome` in pi → Chrome opens, "Opening Chrome" spoken
- [ ] Manual: `/alfred what's happening in sandbox` → context gathered, agent reads it, speech describes sandbox state

## Completion Criteria

- [ ] `/alfred <anything>` in pi routes through Alfred 2.0 pipeline: context → agent → execute → speak
- [ ] Context gathering takes < 2 seconds, shown as progress in pi output
- [ ] Agent responses are spoken via pi's speech capability
- [ ] Commands are executed via pi's bash tool (safe ones immediately, destructive ones after confirmation)
- [ ] Alfred 1.x daemon still works when 2.0 is disabled
- [ ] All existing pi functionality unaffected

## Notes

- Source code lives in the alfred repo under `src/alfred-2/`. The extension is developed there and synced to `~/.pi/agent/extensions/` for pi to load.
- Pi extension API provides: `pi.sendMessage()`, `pi.speak()`, `pi.registerTool()`, `pi.on()`. We use `pi.registerTool()` for `/alfred`, `pi.speak()` for speech output.
- The extension is a single file for simplicity, unlike Alfred 1.x which spans 20+ source files.
- Display format in pi terminal:
  ```
  /alfred what's happening in sandbox
  ─── Alfred 2.0 ───
  Context: 5 workspaces, 2 PRs, 0 notifications (0.8s)
  Thinking... (1.2s)
  
  Your sandbox workspace at ~/work/sandbox/backend has 5 tabs open.
  Branch feature/powerco-mixed-depth-manager-hierarchy is clean.
  PR #3130 is open with all CI checks passing.
  ─────────────────
  ```
