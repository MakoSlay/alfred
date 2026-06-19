# 006 - Web Dashboard Foundation

## Goal

Create the first local web dashboard for observing Alfred activity and cmux-visible agent sessions.

## Scope

Build a minimal local dashboard in the standalone project. It does not need polished UI, but it must expose useful state and action history.

## Checklist

- [ ] Add a local dashboard app or static server route in the standalone project.
- [ ] Display visible workspaces/surfaces from `GET /surfaces`.
- [ ] Display pending draft state from `GET /state`.
- [ ] Display recent event/history entries.
- [ ] Add controls or placeholders for confirm, cancel, and refresh.
- [ ] Add tests or smoke coverage for dashboard route/build behavior.

## Tests

```bash
cd /Users/muhammadabdul/work/cmux-operator
npm run check
npm run typecheck
npm test
```

If the dashboard adds a build command, run it and record the output below.

## Completion Criteria

- [ ] Dashboard can be opened locally.
- [ ] Dashboard shows surfaces, pending drafts, and recent activity.
- [ ] Dashboard does not expose secrets.
- [ ] Validation results are recorded below.

## Notes

_To be filled during implementation._

## Validation

_To be filled during implementation._

## Blockers

_None currently._
