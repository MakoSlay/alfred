# Alfred Plan

## Purpose

Build Alfred as a standalone local cmux-backed personal assistant that can observe, coordinate, and safely command Pi, Codex, shells, and other terminal agents or processes visible to cmux.

The current Pi extension remains the live `/alfred` path during parallel development. The long-term direction is inverted: Alfred owns the runtime, and Pi becomes one important interface/target rather than the place Alfred lives.

## Target Project Location

Recommended standalone project path:

```text
/Users/muhammadabdul/work/alfred
```

This should be a personal/local tooling repo, not a Diversio monolith submodule. The existing source repo remains:

```text
/Users/muhammadabdul/work/pi-smart-voice-notify
```

## Completion Promise

Foundation promise reached for tasks 000-007:

```text
ALL 8 ALFRED-LOCAL TASKS COMPLETE
```

Task 008 is also complete and established the live daemon start path. The current daemon-expansion phase covers tasks 009-013. Its completion promise is:

```text
ALL 5 ALFRED-DAEMON-EXPANSION TASKS COMPLETE
```

This phase is complete when Alfred has daemon-owned planning, loop foundation, local persistence rules/storage, dashboard polish, and opt-in Pi loop bridge migration with fallback safety.

## Quality Gates

Run these in `/Users/muhammadabdul/work/pi-smart-voice-notify` whenever the current Pi extension is touched:

```bash
npm run check
npm run typecheck
npm test
```

Run equivalent gates in `/Users/muhammadabdul/work/alfred` once that project exists:

```bash
npm run check
npm run typecheck
npm test
```

If the new project initially lacks one of those scripts, add the missing script before marking the task complete.

## Non-Negotiable Safety Rules

- Do not break the current `/alfred` Pi flow.
- Do not move secrets from the live Pi extension into the new repo.
- Treat transcript/history data as sensitive local data: redact secrets where possible, define retention, and avoid committing captured transcripts.
- Do not expose action APIs beyond localhost/Unix socket without an explicit auth model.
- Do not make the Pi extension depend on the new daemon by default.
- Any new bridge from Pi to the daemon must be feature-flagged and fail closed back to the existing Pi-local behavior.
- Keep `/alfred` as the current Pi entrypoint, but do not architect the daemon as if Pi is the only long-term input/output surface.
- cmux should be treated as the substrate/control plane, not as the owner of Alfred product policy.

## Task Index

- [x] 000 - Orientation and boundary map ([000-orientation.md](000-orientation.md); depends on: None)
- [x] 001 - Runtime contracts and event model ([001-runtime-contracts.md](001-runtime-contracts.md); depends on: 000)
- [x] 002 - Standalone project skeleton ([002-standalone-project-skeleton.md](002-standalone-project-skeleton.md); depends on: 001)
- [x] 003 - cmux world model adapter ([003-cmux-world-model-adapter.md](003-cmux-world-model-adapter.md); depends on: 002)
- [x] 004 - Alfred daemon API ([004-alfred-daemon-api.md](004-alfred-daemon-api.md); depends on: 001, 002, 003)
- [x] 005 - Draft-confirm and action execution ([005-draft-confirm-action-execution.md](005-draft-confirm-action-execution.md); depends on: 004)
- [x] 006 - Web dashboard foundation ([006-web-dashboard-foundation.md](006-web-dashboard-foundation.md); depends on: 004, 005)
- [x] 007 - Pi bridge and extraction path ([007-pi-bridge-extraction-path.md](007-pi-bridge-extraction-path.md); depends on: 004, 005)
- [x] 008 - Daemon CLI and live smoke path ([008-daemon-cli-and-live-smoke-path.md](008-daemon-cli-and-live-smoke-path.md); depends on: 004, 005, 006, 007)
- [x] 009 - LLM action planner adapter ([009-llm-action-planner-adapter.md](009-llm-action-planner-adapter.md); depends on: 008)
- [ ] 010 - Daemon-owned loop manager foundation ([010-daemon-owned-loop-manager.md](010-daemon-owned-loop-manager.md); depends on: 008, 009)
- [ ] 011 - Local persistence and retention ([011-local-persistence-and-retention.md](011-local-persistence-and-retention.md); depends on: 008)
- [ ] 012 - Dashboard polish and auth UX ([012-dashboard-polish-and-auth-ux.md](012-dashboard-polish-and-auth-ux.md); depends on: 008)
- [ ] 013 - Pi loop bridge migration ([013-pi-loop-bridge-migration.md](013-pi-loop-bridge-migration.md); depends on: 010)

## External Reference Notes

These references informed the plan shape:

- MCP's host/client/server split supports keeping protocol/tool boundaries explicit rather than baking every tool into one monolith.
- OpenHands' local agent server pattern validates separating client UI from agent/runtime execution with HTTP/WebSocket-style APIs and persisted events.
- CLI Agent Orchestrator-style supervisor/worker patterns validate cmux/tmux-like surfaces as an orchestration substrate.
- Localhost security research shows that browser-reachable local agent gateways need real origin/host/auth protections; localhost alone is not a sufficient trust boundary.

Do not expand scope just because these projects have broader features. Use them as architecture guardrails, not as a mandate to build MCP, full sandboxing, or a polished web app in the first milestone.

## Dependency Notes

- Task 000 prevents blind extraction by documenting what exists today.
- Tasks 001 and 002 define the new project's stable shape before implementation accelerates.
- Task 003 proves the new runtime can see cmux surfaces without Pi.
- Tasks 004 and 005 make the runtime useful without touching the Pi extension.
- Task 006 can progress once the daemon exposes state and history.
- Task 007 must remain opt-in, should not happen before the daemon can safely answer `/handle` and `/confirm`, and should move Alfred toward daemon ownership rather than deeper Pi-extension coupling.
- Task 008 is the first next-phase implementation target because all later live work needs a polished daemon start path.
- Task 009 should reuse Pi-local planner hardening ideas while keeping daemon contracts source-agnostic. The planner augments the existing deterministic draft parser; deterministic matching remains the fallback when no planner is configured or planner output is invalid.
- Task 010 establishes daemon-owned loop contracts and a manager foundation only; Pi bridge loop migration is split into Task 013 so the foundation remains atomic. The first autonomous-send approval model is the explicit `loop.autonomousSend` capability; without it, loop sends must become pending drafts.
- Task 011 should decide retention/redaction before durable storage is added. The initial storage direction is app-dir JSONL audit events plus small metadata files; pending drafts remain session-only unless a later task documents a stronger safety rationale. Loop-state persistence should coordinate with Task 010 but does not block the initial storage decision.
- Task 012 is intentionally after daemon basics; dashboard polish should not relax local security protections. Loop/persistence display can remain placeholder-only until Tasks 010 and 011 land.
- Task 013 moves Pi's autonomous loop bridge path to daemon ownership after the daemon loop manager foundation exists.

## Progress Tracking

- [x] Existing Pi extension still works — Pi extension gates passed after the optional daemon bridge change.
- [x] New standalone repo created outside monolith — created at `/Users/muhammadabdul/work/alfred` and pushed to private GitHub repo `MakoSlay/alfred`.
- [x] cmux adapter can list current workspaces/surfaces — `src/cmux/index.ts` implements workspace/surface listing and fixture-backed target resolution.
- [x] daemon can handle and confirm drafts — Task 005 adds pending drafts, `/confirm`, `/cancel`, `send that`, and cmux-backed confirmed sends.
- [x] web dashboard shows recent activity — `GET /dashboard` renders surfaces, pending drafts, and recent event history via authenticated daemon APIs.
- [x] Pi bridge is feature-flagged — bridge is opt-in through `ALFRED_DAEMON_ENABLED` / `PI_SMART_NOTIFY_ALFRED_DAEMON_ENABLED` and falls back to Pi-local behavior.
- [x] Non-Pi entrypoint shape is defined — `docs/contracts/runtime-contracts.md` defines Pi, CLI, web UI, voice, text, and system sources.
- [x] Daemon has an operator CLI/start path — Task 008 added `npm run daemon`, env config, startup output, and shutdown handling.
- [x] Live daemon + Pi bridge smoke is documented — Task 008 recorded curl smoke; optional opt-in Pi bridge procedure remains documented and not default.
- [x] Daemon-owned planning parity is started — Task 009 added a source-agnostic planner seam, sanitized planner input, strict action validation, and draft-confirm-only send proposals.
- [ ] Daemon-owned loop foundation is started — Task 010 should define loop contracts and in-daemon lifecycle management without bundling Pi migration.
- [ ] Pi loop bridge migration is planned separately — Task 013 should move Pi loop controls to daemon mode only after Task 010 exists.
- [ ] Local persistence decision is explicit — Task 011 should define storage, retention, redaction, and reset behavior before durable data is stored.

## Completion

- [x] Foundation milestone is complete: tasks 000-007 are checked and the promise `ALL 8 ALFRED-LOCAL TASKS COMPLETE` has been reached.
- [ ] Daemon-expansion milestone is complete: tasks 009-013 are checked and `ALL 5 ALFRED-DAEMON-EXPANSION TASKS COMPLETE` is true.
- [x] Standalone Alfred gates pass for each standalone task that changes code.
- [ ] Pi extension gates pass for each task that changes `/Users/muhammadabdul/work/pi-smart-voice-notify`.
- [ ] Live smoke findings are recorded for daemon CLI, dashboard, and opt-in Pi bridge paths.

## Fresh-Eyes Review Checklist

Foundation review before declaring the first eight tasks complete:

- [x] All original task files have Goal, Scope, Checklist, Tests, and Completion Criteria.
- [x] Each original task has 4-8 checklist items.
- [x] The current Pi extension remains usable without the new daemon.
- [x] The new runtime is outside the monolith and does not store secrets.
- [x] Quality gates are runnable in each touched repo.
- [x] `RALPH-PROMPT.md` contains no unreplaced template placeholders.
- [x] The foundation completion promise is `ALL 8 ALFRED-LOCAL TASKS COMPLETE`.
- [x] The daemon-expansion completion promise is defined as `ALL 5 ALFRED-DAEMON-EXPANSION TASKS COMPLETE`.

Next-phase planning review:

- [x] Tasks 008-013 are appended without renumbering completed work.
- [x] Task 008 is the first implementation target and is sized for an atomic commit.
- [x] Each next-phase task has Goal, Dependencies, Scope, Checklist, Tests, Completion Criteria, Notes, and Blockers.
- [x] Next-phase tasks preserve Pi-local default behavior and daemon opt-in bridge behavior.
- [x] Security constraints explicitly cover token handling, localhost/browser risk, no direct `/send`, and no secret/transcript commits.
