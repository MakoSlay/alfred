# 006 - Web Dashboard Foundation

## Goal

Create the first local web dashboard for observing Alfred activity and cmux-visible agent sessions.

## Scope

Build a minimal local dashboard in the standalone project. It does not need polished UI, but it must expose useful state and action history.

## Checklist

- [x] Add a local dashboard app or static server route in the standalone project.
- [x] Display visible workspaces/surfaces from `GET /surfaces`.
- [x] Display pending draft state from `GET /state`.
- [x] Display recent event/history entries with secret-aware redaction and retention limits.
- [x] Add controls or placeholders for confirm, cancel, and refresh.
- [x] Ensure state-changing controls use the daemon's local auth/guard strategy.
- [x] Add tests or smoke coverage for dashboard route/build behavior.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

If the dashboard adds a build command, run it and record the output below.

## Completion Criteria

- [x] Dashboard can be opened locally.
- [x] Dashboard shows surfaces, pending drafts, and recent activity.
- [x] Dashboard does not expose secrets or long-lived raw transcript dumps.
- [x] State-changing dashboard actions are guarded.
- [x] Validation results are recorded below.

## Notes

Implemented a minimal local dashboard as a static daemon route in `src/daemon/index.ts`.

Key behavior:

- `GET /` and `GET /dashboard` render a local HTML dashboard without requiring Pi or a separate frontend build.
- The static route still uses Alfred's host/origin guard, but it does not expose daemon state without a local token.
- The page asks for the local daemon token and uses `x-alfred-auth` for `GET /state`, `GET /surfaces`, `POST /confirm`, and `POST /cancel`.
- The dashboard displays:
  - visible cmux targets from `/surfaces`;
  - pending drafts from `/state`;
  - recent events/history from `/state`;
  - confirm/cancel/refresh controls.
- Dynamic data is rendered with `textContent`, not HTML injection.
- Draft display uses redaction metadata: text marked `redacted` or `contains_sensitive` is shown as `[redacted]`.
- Event display uses event summaries, redaction status, and retention policy instead of raw transcript dumps.
- The response includes a tight Content Security Policy, no CORS headers, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`.

Tests in `test/daemon.test.ts` verify that the dashboard route renders locally, contains refresh/confirm/cancel/auth-header wiring, does not embed the daemon token, has no permissive CORS header, and rejects an untrusted browser origin.

No separate dashboard build command was added; the dashboard is served by the daemon.

## Validation

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
```

Passed. `npm test` ran 19 Node test cases total, including dashboard route smoke coverage.

The Pi extension repo was not modified, so Pi extension gates were not required.

## Blockers

_None currently._
