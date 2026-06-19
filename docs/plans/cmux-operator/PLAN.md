# CMUX Operator Plan

## Purpose

Build Alfred's next-generation local orchestration platform as a standalone cmux-backed runtime while keeping the existing Pi extension usable and stable.

The current Pi extension remains the live product path. The new runtime is built separately, outside the Diversio monolith, and the Pi extension only bridges to it behind an opt-in flag once the server is useful.

## Target Project Location

Recommended standalone project path:

```text
/Users/muhammadabdul/work/cmux-operator
```

This should be a personal/local tooling repo, not a Diversio monolith submodule. The existing source repo remains:

```text
/Users/muhammadabdul/work/pi-smart-voice-notify
```

## Completion Promise

```text
ALL 8 CMUX-OPERATOR TASKS COMPLETE
```

## Quality Gates

Run these in `/Users/muhammadabdul/work/pi-smart-voice-notify` whenever the current Pi extension is touched:

```bash
npm run check
npm run typecheck
npm test
```

Run equivalent gates in `/Users/muhammadabdul/work/cmux-operator` once that project exists:

```bash
npm run check
npm run typecheck
npm test
```

If the new project initially lacks one of those scripts, add the missing script before marking the task complete.

## Non-Negotiable Safety Rules

- Do not break the current `/alfred` Pi flow.
- Do not move secrets from the live Pi extension into the new repo.
- Do not make the Pi extension depend on the new daemon by default.
- Any new bridge from Pi to the daemon must be feature-flagged and fail closed back to the existing Pi-local behavior.
- cmux should be treated as the substrate/control plane, not as the owner of Alfred product policy.

## Task Index

| Order | Task | File | Status | Depends On |
|---:|---|---|---|---|
| 000 | Orientation and boundary map | [000-orientation.md](000-orientation.md) | Not Started | None |
| 001 | Runtime contracts and event model | [001-runtime-contracts.md](001-runtime-contracts.md) | Not Started | 000 |
| 002 | Standalone project skeleton | [002-standalone-project-skeleton.md](002-standalone-project-skeleton.md) | Not Started | 001 |
| 003 | cmux world model adapter | [003-cmux-world-model-adapter.md](003-cmux-world-model-adapter.md) | Not Started | 002 |
| 004 | Alfred daemon API | [004-alfred-daemon-api.md](004-alfred-daemon-api.md) | Not Started | 001, 002, 003 |
| 005 | Draft-confirm and action execution | [005-draft-confirm-action-execution.md](005-draft-confirm-action-execution.md) | Not Started | 004 |
| 006 | Web dashboard foundation | [006-web-dashboard-foundation.md](006-web-dashboard-foundation.md) | Not Started | 004, 005 |
| 007 | Optional Pi bridge and parallel cutover | [007-optional-pi-bridge-parallel-cutover.md](007-optional-pi-bridge-parallel-cutover.md) | Not Started | 004, 005 |

## Dependency Notes

- Task 000 prevents blind extraction by documenting what exists today.
- Tasks 001 and 002 define the new project's stable shape before implementation accelerates.
- Task 003 proves the new runtime can see cmux surfaces without Pi.
- Tasks 004 and 005 make the runtime useful without touching the Pi extension.
- Task 006 can progress once the daemon exposes state and history.
- Task 007 must remain opt-in and should not happen before the daemon can safely answer `/handle` and `/confirm`.

## Progress Tracking

| Gate | Status | Notes |
|---|---|---|
| Existing Pi extension still works | Not Verified | Run existing gates after any source changes. |
| New standalone repo created outside monolith | Not Started | Target path: `/Users/muhammadabdul/work/cmux-operator`. |
| cmux adapter can list current workspaces/surfaces | Not Started | Requires Task 003. |
| daemon can handle and confirm drafts | Not Started | Requires Tasks 004-005. |
| web dashboard shows recent activity | Not Started | Requires Task 006. |
| Pi bridge is feature-flagged | Not Started | Requires Task 007. |

## Fresh-Eyes Review Checklist

Before declaring the plan complete:

- [ ] All task files have Goal, Scope, Checklist, Tests, and Completion Criteria.
- [ ] Each task has 4-8 checklist items.
- [ ] The current Pi extension remains usable without the new daemon.
- [ ] The new runtime is outside the monolith and does not store secrets.
- [ ] Quality gates are runnable in each touched repo.
- [ ] `RALPH-PROMPT.md` contains no unreplaced template placeholders.
- [ ] The completion promise is exactly `ALL 8 CMUX-OPERATOR TASKS COMPLETE`.
