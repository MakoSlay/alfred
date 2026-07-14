# 007 - CI Status & Log Tools

## Goal

Let Alfred check CI status and inspect failing logs from voice commands in the relevant repo/workspace.

## Dependencies

- Requires: 001, 003
- Blocks: 009

## Scope

**In scope:**
- Add `ci_status` tool using `gh` CLI for GitHub Actions and PR discovery.
- Add `ci_logs` tool for a specific failing run/job where available.
- Run CI commands from the selected workspace/cwd according to `workspace-resolution.md`, not blindly from the Alfred repo.
- Return concise per-job status, URLs, and failure excerpts.
- Support CircleCI later if `CIRCLECI_TOKEN` is configured, but do not block GitHub-only support.

**Out of scope:**
- Interactive TUI CI viewer.
- Automatically fixing CI failures.
- Force-pushing or PR mutation.
- Claiming a failure is a flake without evidence.

## Checklist

- [x] Implement repo/cwd resolution for CI tools using current cmux workspace active repo by default.
- [x] Implement branch/PR discovery with `gh pr view` / `gh pr list --head`.
- [x] Implement GitHub Actions status collection with job names, conclusion, URL, and duration when possible.
- [x] Implement log fetching for failed jobs/runs with truncation.
- [x] Add prompt guidance for classifying failures as likely ours/flake/unclear only when evidence exists.
- [x] Add graceful errors for unauthenticated `gh`, no git repo, no PR, or branch not pushed.

## Tests

- [x] Add unit tests with mocked `gh` outputs.
- [x] Add test: no PR found returns helpful message.
- [x] Add test: failed job log is truncated with indicator.
- [x] Add test: CI command uses current cmux workspace active repo when no explicit repo is named.
- [x] Add test: CI command does not run against the Alfred repo as implicit fallback.
- [x] Manual: `Alfred, are my CI checks green?` in a PR branch.
- [x] Run `npm run check`.

## Completion Criteria

- [x] Alfred can report CI green/red/running by voice.
- [x] Alfred can summarize the first useful failure from logs.
- [x] Alfred does not invent failure causes when logs are unavailable.
- [x] Alfred checks CI for the intended repo/workspace.

## Notes

- Model this after pi's CI skill, but implement it as Alfred tools around local CLIs/APIs.
