# 004 — Context & Dashboard Observability

## Goal

Make Alfred 2's live context and decisions visible enough to debug real voice requests without reading logs.

## Why

Alfred 2 relies on pre-injected context and a tool loop. When it chooses the wrong workspace, misses a fact, or refuses a command, the operator needs to see what Alfred believed at request time.

## Scope

**In scope:**

- Dashboard state improvements.
- Request trace visibility.
- Context summary visibility.
- Pending confirmation details.
- Tool event summaries.

**Out of scope:**

- Full log streaming UI.
- Remote monitoring.
- Rich metrics backend.

## Checklist

- [ ] Add current/selected workspace and cwd to `/dashboard/state`.
- [ ] Add recent parsed workspaces list to `/dashboard/state`, capped and sanitized.
- [ ] Add last request summary: requestId, user text summary/redaction, resolved workspace/cwd, tools used, final status.
- [ ] Add recent tool events with tool name, success, cwd/workspace, duration, and truncated text.
- [ ] Add pending confirmation details: id, risk, preview, cwd, workspaceRef, expiration.
- [ ] Add token threshold display: current tokens, warn threshold, handoff threshold.
- [ ] Add mute expiration display, not just muted/unmuted.
- [ ] Keep full stdout, secrets, large file contents, and raw LLM output out of dashboard state by default.

## Tests

- [ ] `/dashboard/state` includes workspace/cwd fields when context is available.
- [ ] `/dashboard/state` excludes raw stdout and obvious secret fields.
- [ ] Pending confirmation count and details update after a confirmation-required tool call.
- [ ] Mute status includes expiration/remaining time.
- [ ] `npm run check` passes.

## Completion Criteria

- [ ] The dashboard answers: what Alfred knows, where Alfred will act, what is pending, and what just happened.
- [ ] Dashboard observability does not leak secrets or huge outputs.
