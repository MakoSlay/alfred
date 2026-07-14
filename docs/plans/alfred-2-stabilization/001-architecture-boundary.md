# 001 — Architecture Decision & Boundary Cleanup

## Goal

Make Alfred 2's actual architecture explicit and remove ambiguity between Alfred 1 and Alfred 2 responsibilities.

## Why

The original Alfred 2 plan described an inline pi extension with no daemon/server. The implementation now has a standalone local server, dashboard, Wispr listener, tool loop, confirmations, memory, and undo. That is a valid direction, but it must be documented so future work does not accidentally rebuild Alfred 1 inside Alfred 2.

## Scope

**In scope:**

- Document Alfred 2 as a standalone local voice-agent server.
- Define Alfred 1 vs Alfred 2 boundaries.
- Decide which entrypoint is primary for voice requests.
- Identify stale plan language that conflicts with the implementation.
- Clarify that Alfred 2 uses a tool loop, not Alfred 1's planner/action-registry model.

**Out of scope:**

- Rewriting Alfred 1.
- Removing Alfred 1 daemon/dashboard.
- Adding new tools.

## Checklist

- [ ] Update or supersede `docs/plans/alfred-2/PLAN.md` so it no longer claims Alfred 2 has no server/daemon if this architecture is accepted.
- [ ] Add a short architecture note for Alfred 2: voice input, HTTP server, dashboard, context gatherer, LLM tool loop, tool registry, confirmation store, memory/history, speech output.
- [ ] Document Alfred 1 as the typed cmux control daemon and Alfred 2 as the voice-agent operator loop.
- [ ] Document whether `/ask` in Alfred 2 is the primary path for Wispr and dashboard Quick Ask.
- [ ] Document which Alfred 1 code should not be ported unless there is a clear need: planner intent union, cmux adapter layer, action registry expansion.
- [ ] Add a short list of future extension points: new tools, richer context, better dashboard state, optional pi integration.

## Tests

- [ ] Documentation-only task; run `npm run typecheck` if imports or docs links are touched in code comments.

## Completion Criteria

- [ ] A new contributor can read the docs and understand why Alfred 2 has a server/dashboard even though early plans said otherwise.
- [ ] Alfred 1 and Alfred 2 responsibilities are clearly separated.
