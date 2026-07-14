# 005 — Voice Workflow Smoke Matrix

## Goal

Validate Alfred 2 as the user experiences it: spoken request in, visible/safe action, concise speech out.

## Why

Unit tests prove the pieces work. Alfred 2 succeeds only if the real voice flows feel reliable: it hears the wake phrase, uses the right workspace, runs tools safely, recovers from errors, and speaks briefly.

## Scope

**In scope:**

- Manual smoke matrix for Wispr + Alfred 2 server.
- Automated integration tests where feasible.
- Golden response expectations for common spoken workflows.
- Regression checks for mute, undo, confirmation, memory, and dashboard state.

**Out of scope:**

- Voice recognition model tuning.
- Non-local deployment.
- New capability development beyond fixing smoke failures.

## Smoke Matrix

Run these against a safe local setup with at least one scratch workspace:

- [ ] "Alfred, what can you do?" → lists core tool categories briefly.
- [ ] "Alfred, what workspace am I in?" → answers from pre-gathered context without discovery commands.
- [ ] "Alfred, run git status here" → uses selected workspace cwd.
- [ ] "Alfred, run tests in Alfred and tell me if they pass" → runs in correct workspace and summarizes.
- [ ] "Alfred, read package.json and tell me the scripts" → uses file tool or safe command in correct cwd.
- [ ] "Alfred, change this scratch file from X to Y" → requests confirmation or auto-confirms if enabled; undo snapshot created.
- [ ] "Alfred, undo that" → restores from undo history.
- [ ] "Alfred, check CI" → uses CI tool in the relevant workspace.
- [ ] "Alfred, search the web for today's TypeScript release notes" → uses web search when configured, graceful error otherwise.
- [ ] "Alfred, mute for 30 minutes" → no speech after mute, dashboard shows muted state.
- [ ] "Alfred, are you muted?" → returns status silently/textually as designed.
- [ ] "Alfred, unmute" → speech resumes.
- [ ] Dangerous command, e.g. `rm -rf scratch-dir` → requires explicit confirmation, never auto-runs.
- [ ] Ambiguous workspace name → asks which workspace, no execution.

## Automated Tests To Add Where Feasible

- [ ] Workspace/cwd smoke test for selected workspace.
- [ ] Workspace/cwd smoke test for explicit non-selected workspaceRef.
- [ ] Confirmation drift test.
- [ ] Dashboard state updates after a request.
- [ ] Mute suppresses speech but not API display text.

## Completion Criteria

- [ ] The full smoke matrix passes or failures are documented as follow-up bugs.
- [ ] At least the safety-critical cases are automated.
- [ ] `npm run check` passes after fixes.
