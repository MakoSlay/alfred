# 009 - Watcher Recipe System

## Goal

Introduce user-facing watchers backed by declarative recipe definitions for safe repeatable workflows such as watching CI, tests, PRs, sessions, and dev servers.

## Dependencies

- Requires: 002, 004, 006, 008
- Blocks: 010, 011, 013

## Scope

**In scope:**
- Define a recipe schema with name, description, inputs, permissions, steps, schedule, notifications, auto-send permission scope, and stop conditions.
- Use **watcher** as the product/UI term; `recipe` may remain the internal schema/implementation term.
- Add recipe registry/loading for built-in watchers and future local user recipes.
- Start, stop, inspect, and list watcher-backed loops through daemon APIs and dashboard cards.
- Clear active watchers on daemon restart while preserving safe watcher configuration/history metadata.

**Out of scope:**
- Arbitrary untrusted recipe execution.
- Full visual recipe editor.

## Checklist

- [ ] Define watcher/recipe schema and TypeScript types with validation.
- [ ] Implement built-in watcher registry with metadata and input validation.
- [ ] Connect watcher start/stop/status to the daemon loop manager.
- [ ] Enforce permission requirements before a watcher starts or executes a side effect.
- [ ] Add explicit watcher auto-send permission fields scoped to target, action type, frequency, and lifetime.
- [ ] Add dashboard list/start/stop/inspect controls for built-in watchers.

## Tests

- [ ] Run `npm run typecheck` and verify watcher/recipe contracts compile.
- [ ] Run `npm test` and verify valid watcher loading, invalid watcher rejection, permission gating, restart clearing active watchers, and loop start/stop behavior.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA: start a harmless built-in watcher, inspect its loop state, then stop it.

## Completion Criteria

- [ ] Alfred can load validated built-in watchers.
- [ ] Watchers can start daemon-owned loops with explicit inputs and permissions.
- [ ] Watchers with auto-send behavior require explicit, scoped user permission.
- [ ] Invalid or overpowered watchers are rejected before execution.

## Notes

- Watchers are the safe bridge between "Alfred can plan" and "Alfred can act repeatedly."
- Product language should say watcher; implementation may still use recipe for declarative definitions.
- Active watcher runtime state should not resume automatically after restart. Persisted configuration/history can remain so users can restart previous watchers intentionally.
