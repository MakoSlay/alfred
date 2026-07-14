# 004 — Semantic Stuck/Stopped Work Watcher

Canonical details: `IMPLEMENTATION.md#004--semantic-stuckstopped-work--redesigned-mvp`.

## Verdict

Previous design drifted toward a generalized workstream intelligence platform. Phase 1 should be conservative, opt-in, and scoped to watched workstreams only.

## Phase 1 Goal

For an explicitly watched workspace/workstream, distinguish:

- active but stuck;
- quiet/paused;
- stopped incomplete;
- urgent.

Emit dashboard/notification events and optional confirmed follow-up suggestions. Do not auto-nudge agents.

## In Scope — Phase 1

- Opt-in watcher per workspace/workstream.
- 10-minute polling for watched workstreams only.
- Compact recent snapshot.
- Existing `LlmClient` verdict step.
- Stopped-vs-stuck classification.
- `ProactiveEvent.suggestedAction` for “Add to follow-up”.

## Out of Scope — Phase 1

- Global always-on workstream tracking.
- Sophisticated project/PR/survey/CSB grouping across all chats.
- Long-term workstream memory.
- Auto-nudge grants.
- Rich dashboard controls.
- Direct Notes writes from stuck watcher.

## Rules

- Use resolved cmux workspace/cwd only. Never use Alfred process `pwd` as fallback.
- If no cwd/workspace context exists, skip git/process analysis and mark that signal unavailable.
- Store only verdict metadata/evidence summaries, not raw terminal/chat content.
- `userSwitchedAway` is true only with cmux active-workspace evidence or a clearly classified different-workstream Alfred conversation; otherwise false.
- Alert only after 2 consecutive medium+ `stuck` or `urgent` verdicts from separate polls.
- `stopped_incomplete` never speaks by default.
- Stuck watcher never imports/calls Notes directly; it emits `suggestedAction` and confirmation flow handles Notes.

## Verdict Mapping

| Verdict | Priority | Default delivery |
|---------|----------|------------------|
| `progressing` | `silent` | store only |
| `quiet` | `silent` | store only |
| `paused_by_user` | `silent` | store only |
| `stopped_incomplete` | `low` | dashboard + optional follow-up action |
| `stuck` | `important` | notification + possible speech if policy allows |
| `urgent` | `urgent` | notification; no speech if muted/in meeting/unknown |

## Suggested Modules

```txt
src/alfred-2/watchers/stuck-work.ts
src/alfred-2/watchers/workstream-snapshot.ts
```

## Tests

- [ ] No-cwd fail-closed behavior.
- [ ] Structured verdict parsing.
- [ ] Stopped-vs-stuck classification.
- [ ] Consecutive-verdict threshold.
- [ ] Verdict-to-priority mapping.
- [ ] No raw content persistence.
- [ ] `suggestedAction` path for stopped incomplete.
- [ ] No auto-send/nudge by default.

## Completion Criteria

- [ ] Alfred can conservatively flag likely stuck work on watched workstreams.
- [ ] Alfred can identify stopped incomplete work without nagging.
- [ ] Alfred never auto-nudges another agent/chat in Phase 1.
