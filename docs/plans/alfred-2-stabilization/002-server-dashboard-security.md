# 002 — Local Server & Dashboard Security

## Goal

Harden Alfred 2's local server and dashboard to match the risk of its capabilities: command execution, file writes, undo restore, profile mutation, mute controls, and ask requests.

## Why

Alfred 2 now exposes local HTTP endpoints. Even if bound to loopback, browser-origin and DNS-rebinding style protections matter because endpoints can trigger local actions. Alfred 1 already has useful patterns for host/origin guards, local auth, CSP, and no-store headers.

## Scope

**In scope:**

- Loopback-only host validation.
- Host header guard.
- Origin guard for browser-style requests.
- Local auth token for mutation/control endpoints.
- Dashboard token UX similar to Alfred 1, or an explicit alternative with equivalent safety.
- Security headers for HTML and JSON responses.
- Tests for allowed and denied requests.

**Out of scope:**

- Multi-user auth.
- Remote network access.
- OAuth or external identity.

## Checklist

- [ ] Add Alfred 2 config for `host`, `port`, `authToken`, `allowedHosts`, and `allowedOrigins` with safe defaults.
- [ ] Reject non-loopback `ALFRED2_HOST` unless an explicit development override exists.
- [ ] Require auth for mutating/control endpoints: `/ask`, `/handle`, `/mute`, `/unmute`, `/dashboard/facts`, `/dashboard/undo`, undo restore.
- [ ] Decide whether read-only endpoints (`/health`, `/dashboard`) may remain unauthenticated; if public, ensure the HTML embeds no state/secrets.
- [ ] Add `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and CSP for dashboard HTML.
- [ ] Ensure no token is accepted in query strings.
- [ ] Update dashboard JS to send `x-alfred-auth` or `Authorization: Bearer` from localStorage, matching the chosen auth model.
- [ ] Redact auth token in startup logs.
- [ ] Print dashboard URL and auth instructions from `src/alfred-2/cli.ts`.

## Tests

- [ ] `GET /dashboard` renders HTML with CSP/no-store/nosniff and no embedded token.
- [ ] `POST /ask` without auth is rejected when auth is configured.
- [ ] `POST /ask` with `x-alfred-auth` succeeds.
- [ ] Cross-origin browser-style mutation request is rejected.
- [ ] Bad Host header is rejected.
- [ ] Query-token patterns are rejected or ignored.
- [ ] `npm run check` passes.

## Completion Criteria

- [ ] Alfred 2 dashboard/control endpoints are safe to expose on loopback for personal-local use.
- [ ] The dashboard remains usable without placing secrets in URLs or rendered HTML.
