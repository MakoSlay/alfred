# Ralph Prompt: CMUX Operator

You are implementing the CMUX Operator plan.

The plan lives at:

```text
/Users/muhammadabdul/work/cmux-operator/docs/plans/cmux-operator
```

The current live Alfred/Pi extension source repo is:

```text
/Users/muhammadabdul/work/pi-smart-voice-notify
```

The new standalone project should be created outside the Diversio monolith at:

```text
/Users/muhammadabdul/work/cmux-operator
```

## Completion Promise

Do not claim completion until this exact promise is true:

```text
ALL 8 CMUX-OPERATOR TASKS COMPLETE
```

## First Actions Every Iteration

1. Inspect git state in `/Users/muhammadabdul/work/pi-smart-voice-notify`.
2. If `/Users/muhammadabdul/work/cmux-operator` exists, inspect git state there too.
3. Read `PLAN.md` and identify the first incomplete task whose dependencies are complete.
4. Read that task file fully before editing.
5. Check recent commits to avoid repeating already-completed work.

## Live-System Safety Rules

- The existing Pi extension must remain usable while this plan runs.
- Do not remove the existing in-extension Alfred path.
- Do not require the new daemon for `/alfred` by default.
- Any Pi-to-daemon bridge must be opt-in through configuration or an environment flag.
- If the daemon is absent, crashed, or misconfigured, Pi must fall back to current local behavior.
- Do not copy live credentials or secrets from the installed extension into the repo or the new project.

## Architecture Intent

Build a local orchestration platform powered by cmux:

```text
Pi extension / CLI / Web UI
        -> Alfred daemon/server
            -> Alfred core contracts and state
            -> cmux world model adapter
            -> LLM/action planner adapter
            -> optional Pi bridge metadata
```

cmux is the substrate for workspaces, tabs, surfaces, input, and transcript access. Alfred owns product policy: draft confirmation, loops, memory, action history, and web/dashboard UX.

## Required Quality Gates

When touching `/Users/muhammadabdul/work/pi-smart-voice-notify`, run:

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

When touching `/Users/muhammadabdul/work/cmux-operator`, run:

```bash
cd /Users/muhammadabdul/work/cmux-operator
npm run check
npm run typecheck
npm test
```

If the new project lacks one of these scripts, add it as part of the relevant task before marking the task complete.

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
Complete 00X - Task Name

- Summary bullet
- Summary bullet
- Validation run

Plan: cmux-operator
```

Do not commit generated secrets, local credentials, or machine-specific API keys.

## Blocker Handling

If blocked:

1. Document the blocker in the task file.
2. Document what was attempted.
3. If another independent task can proceed, move to it.
4. If no independent task can proceed, stop with a clear blocker report.

Do not mark a task complete with failing gates unless the task file explicitly documents a true external blocker and `PLAN.md` records the blocked status.

## Final Verification

Before saying the completion promise, verify:

- `PLAN.md` marks all 8 tasks complete.
- Every task file has validation evidence.
- Existing Pi extension gates pass if touched.
- New standalone project gates pass.
- Pi bridge remains opt-in.
- There are no unreplaced template placeholders in plan files.
- The current live extension path was not made dependent on the daemon.

Only then say:

```text
ALL 8 CMUX-OPERATOR TASKS COMPLETE
```
