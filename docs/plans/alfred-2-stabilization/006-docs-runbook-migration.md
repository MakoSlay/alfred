# 006 — Docs, Runbook, and Migration Notes

## Goal

Document how to run, configure, debug, and safely use Alfred 2, and explain how it differs from Alfred 1.

## Scope

**In scope:**

- Setup docs.
- Environment variables.
- Provider configuration.
- Dashboard/auth usage.
- Safety model.
- Workspace/cwd behavior.
- Voice/Wispr usage.
- Alfred 1 vs Alfred 2 migration notes.

**Out of scope:**

- Marketing docs.
- Remote deployment docs.

## Checklist

- [ ] Document startup: `npm run alfred2`, `npm run alfred2:no-wispr`, `npm run alfred2:stop`.
- [ ] Document required/optional env vars: host, port, LLM endpoint/model/key, Wispr listener, Exa/web provider if relevant, auth token once added.
- [ ] Document dashboard URL and token flow.
- [ ] Document safety model: confirmation levels, auto-confirm behavior, destructive command rules, blocked paths.
- [ ] Document workspace/cwd resolution rules and failure modes.
- [ ] Document memory/history/profile facts and where they live.
- [ ] Document undo behavior and limitations.
- [ ] Document manual smoke matrix.
- [ ] Document Alfred 1 vs Alfred 2: when to use each, what architecture belongs where.
- [ ] Update stale plan references that contradict the accepted Alfred 2 architecture.

## Tests

- [ ] Run commands from docs on a fresh shell where practical.
- [ ] `npm run check` passes.

## Completion Criteria

- [ ] A user can start Alfred 2, open the dashboard, ask a voice question, understand confirmations, and stop it cleanly from docs alone.
