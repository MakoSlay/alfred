# 008 - Error Recovery, Safety, and Confirmation

## Goal

Make Alfred resilient and safe: failed tools become recoverable context, dangerous tools require exact pending-call confirmation, and retries are bounded.

## Dependencies

- Requires: 003, 004, 005
- Blocks: 009

## Scope

**In scope:**
- Feed tool failures back into the tool loop so the LLM can try alternatives.
- Expand safety classification from bash-only to every tool.
- Add pending confirmation flow for destructive bash, all file edits, file overwrites, git mutations, package manager mutations, package publish, force push, sudo, kill, and rm.
- Store pending tool calls with id/hash, exact payload, expiry, deterministic tool-generated display preview, and exact cwd/full path. Use `implementation-defaults.md` TTL defaults.
- Add per-request risk summary in API responses/history.
- Add retry limits and stop conditions.
- Tools own `retryable` classification. The loop obeys `retryable`; the LLM does not decide from scratch whether a failure is recoverable.

**Out of scope:**
- User permission profiles.
- Fully autonomous destructive changes.
- Long-term policy learning.
- Re-planning dangerous commands after the user says yes.

## Checklist

- [x] Centralize risk classification in one module using `operational-decisions.md` for git, package manager, file, and destructive command categories.
- [x] Apply confirmation checks to bash and file tools.
- [x] Implement pending confirmation store with expiry, exact payload hash, exact cwd/full path, deterministic preview, and default TTLs: 5 minutes normal mutations, 1 minute destructive.
- [x] Update `/ask` confirmation handling so `confirm:true` executes the pending payload, not a newly generated LLM command.
- [x] Require `confirmationId` when multiple pending confirmations exist; allow bare voice yes/confirm only when exactly one pending item exists.
- [x] Modify the tool loop to allow one or more recovery attempts after non-dangerous failures only when the tool result has `retryable: true`.
- [x] Add refusal/clarification behavior when a request is too risky or underspecified.
- [x] Ensure muted mode still suppresses speech but not safety display text.
- [x] Record denied/confirmed actions in history.

## Tests

- [x] Add test: destructive bash creates pending confirmation instead of executing and preview includes exact command plus exact cwd/full path.
- [x] Add test: `confirm:true` executes the stored exact payload/hash.
- [x] Add test: stale or mismatched confirmation is rejected.
- [x] Add test: confirmed edit fails safely if the target file changed and exact `oldText` no longer matches.
- [x] Add test: every file edit and existing-file overwrite requires confirmation.
- [x] Add test: git/package manager mutations require confirmation while read-only diagnostics do not.
- [x] Add test: failed cmux/browser command can be followed by alternative command.
- [x] Add test: retry loop only retries `retryable: true` failures and stops at max attempts.
- [x] Add test: duplicate `edit_file` match retry guidance leads to narrower oldText or stops, not repeated identical payloads.
- [x] Run `npm run check`.

## Completion Criteria

- [x] Alfred does not execute dangerous mutations without confirmation.
- [x] User confirmation cannot accidentally execute a different regenerated command.
- [x] Alfred can recover from common command/tool errors in the same request.
- [x] Safety decisions are visible in API responses and history.

## Notes

- This is what lets Alfred become more autonomous without becoming reckless.
