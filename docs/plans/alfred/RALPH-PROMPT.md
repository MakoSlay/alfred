# Ralph Prompt: Alfred Daemon Expansion

You are implementing the Alfred daemon expansion plan.

The plan lives at:

```text
/Users/muhammadabdul/work/alfred/docs/plans/alfred
```

The standalone Alfred project lives at:

```text
/Users/muhammadabdul/work/alfred
```

The current live Alfred/Pi extension source repo is:

```text
/Users/muhammadabdul/work/pi-smart-voice-notify
```

## Completion Promise

Tasks 000-008 are complete. Do not claim daemon-expansion completion until this exact promise is true:

```text
ALL 5 ALFRED-DAEMON-EXPANSION TASKS COMPLETE
```

This promise covers tasks 009-013 only:

- 009 - LLM action planner adapter
- 010 - Daemon-owned loop manager foundation
- 011 - Local persistence and retention
- 012 - Dashboard polish and auth UX
- 013 - Pi loop bridge migration

## First Actions Every Iteration

1. Inspect git state in `/Users/muhammadabdul/work/alfred`.
2. Inspect git state in `/Users/muhammadabdul/work/pi-smart-voice-notify`.
3. Read `PLAN.md` and identify the first incomplete task whose dependencies are complete.
4. Read that task file fully before editing.
5. Check recent commits to avoid repeating already-completed work.
6. If the task references Pi-local code, inspect the referenced files before implementing.

## Next-Phase Execution Rules

- Start with the first incomplete task in `PLAN.md`; after Task 008 this should be Task 009 unless another independent dependency-ready task is intentionally selected.
- Respect each task file's `Dependencies`, `Blocks`, and `Related` sections.
- Task 010 must not start until 009 is complete.
- Task 013 must not start until 010 is complete.
- Tasks 011 and 012 can start after 008, but should not invent loop-specific behavior before 010 defines it.
- For every task, keep changes atomic and commit after the task is complete and gates pass.

## Live-System Safety Rules

- The existing Pi extension must remain usable while this plan runs.
- Do not remove the existing in-extension Alfred path.
- Do not require the new daemon for `/alfred` by default.
- Any Pi-to-daemon bridge must be opt-in through configuration or an environment flag.
- If the daemon is absent, crashed, misconfigured, or returns unsupported responses, Pi must fall back to current local behavior.
- Do not copy live credentials, API keys, transcripts, session files, or secrets from the installed extension into the repo or the new project.
- Do not persist raw terminal transcripts by default.
- Do not add direct send shortcuts. Every send-like planner or loop output must become a pending draft unless an explicitly tested autonomous-send approval model is present.

## Architecture Intent

Build Alfred as a local personal assistant powered by cmux:

```text
/alfred in Pi / CLI / Web UI / future voice input
        -> Alfred daemon/server
            -> Alfred core contracts and state
            -> cmux world model adapter
            -> LLM/action planner adapter
            -> daemon-owned loop manager
            -> local persistence with retention/redaction
            -> optional Pi bridge metadata
```

cmux is the substrate for workspaces, tabs, surfaces, input, and transcript access. Alfred owns product policy: draft confirmation, loops, memory, action history, and web/dashboard UX. Pi is the main first-class target/interface, but Alfred must not be architected as Pi-only.

## Required Quality Gates

When touching `/Users/muhammadabdul/work/alfred`, run:

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

When touching `/Users/muhammadabdul/work/pi-smart-voice-notify`, also run:

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

If either project lacks one of those scripts, add the missing script before marking the task complete.

## Task Execution Rules

For each task:

1. Update only files relevant to that task.
2. Keep checklist items in the task file current.
3. Add or update tests for the changed behavior.
4. Run the required gates for every touched repo.
5. Record validation results in the task file.
6. Update `PLAN.md` status when done.
7. Commit the completed task with a clear message.

Suggested commit format:

```text
Complete 009 - LLM Action Planner Adapter

- Summary bullet
- Summary bullet
- Validation run

Plan: alfred
```

Do not commit generated secrets, local credentials, captured transcripts, or machine-specific API keys.

## Blocker Handling

If blocked:

1. Document the blocker in the task file.
2. Document what was attempted.
3. If another independent task can proceed, move to it.
4. If no independent task can proceed, stop with a clear blocker report.

Do not mark a task complete with failing gates unless the task file explicitly documents a true external blocker and `PLAN.md` records the blocked status.

## Final Verification

Before saying the completion promise, verify:

- `PLAN.md` marks tasks 009-013 complete.
- Every task file from 009-013 has validation evidence.
- Standalone Alfred gates pass.
- Pi extension gates pass for any task that touched `/Users/muhammadabdul/work/pi-smart-voice-notify`.
- Pi bridge remains opt-in and fallback-safe.
- Planner and loop sends preserve draft-confirm safety unless an explicit tested autonomous-send approval model is present.
- Persistence does not store raw transcripts by default.
- There are no unreplaced template placeholders in plan files.
- The current live extension path was not made dependent on the daemon.

Only then say:

```text
ALL 5 ALFRED-DAEMON-EXPANSION TASKS COMPLETE
```
