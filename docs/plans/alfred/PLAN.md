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

```text
ALL 8 ALFRED-LOCAL TASKS COMPLETE
```

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

| Order | Task | File | Status | Depends On |
|---:|---|---|---|---|
| 000 | Orientation and boundary map | [000-orientation.md](000-orientation.md) | Complete | None |
| 001 | Runtime contracts and event model | [001-runtime-contracts.md](001-runtime-contracts.md) | Complete | 000 |
| 002 | Standalone project skeleton | [002-standalone-project-skeleton.md](002-standalone-project-skeleton.md) | Complete | 001 |
| 003 | cmux world model adapter | [003-cmux-world-model-adapter.md](003-cmux-world-model-adapter.md) | Not Started | 002 |
| 004 | Alfred daemon API | [004-alfred-daemon-api.md](004-alfred-daemon-api.md) | Not Started | 001, 002, 003 |
| 005 | Draft-confirm and action execution | [005-draft-confirm-action-execution.md](005-draft-confirm-action-execution.md) | Not Started | 004 |
| 006 | Web dashboard foundation | [006-web-dashboard-foundation.md](006-web-dashboard-foundation.md) | Not Started | 004, 005 |
| 007 | Pi bridge and extraction path | [007-pi-bridge-extraction-path.md](007-pi-bridge-extraction-path.md) | Not Started | 004, 005 |

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

## Progress Tracking

| Gate | Status | Notes |
|---|---|---|
| Existing Pi extension still works | Not Verified | Run existing gates after any source changes. |
| New standalone repo created outside monolith | Complete | Created at `/Users/muhammadabdul/work/alfred` and pushed to private GitHub repo `MakoSlay/alfred`. |
| cmux adapter can list current workspaces/surfaces | Not Started | Requires Task 003. |
| daemon can handle and confirm drafts | Not Started | Requires Tasks 004-005. |
| web dashboard shows recent activity | Not Started | Requires Task 006. |
| Pi bridge is feature-flagged | Not Started | Requires Task 007. |
| Non-Pi entrypoint shape is defined | Complete | `docs/contracts/runtime-contracts.md` defines Pi, CLI, web UI, voice, text, and system sources. |

## Fresh-Eyes Review Checklist

Before declaring the plan complete:

- [ ] All task files have Goal, Scope, Checklist, Tests, and Completion Criteria.
- [ ] Each task has 4-8 checklist items.
- [ ] The current Pi extension remains usable without the new daemon.
- [ ] The new runtime is outside the monolith and does not store secrets.
- [ ] Quality gates are runnable in each touched repo.
- [ ] `RALPH-PROMPT.md` contains no unreplaced template placeholders.
- [ ] The completion promise is exactly `ALL 8 ALFRED-LOCAL TASKS COMPLETE`.
