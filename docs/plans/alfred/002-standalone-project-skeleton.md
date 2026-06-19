# 002 - Standalone Project Skeleton

## Goal

Create the new standalone Alfred project outside the Diversio monolith.

## Scope

Initialize `/Users/muhammadabdul/work/alfred` with TypeScript tooling, package scripts, tests, and an initial source layout. Do not move the live Pi extension yet.

## Checklist

- [x] Create `/Users/muhammadabdul/work/alfred` as a separate git repository outside monolith.
- [ ] Add package metadata and TypeScript configuration.
- [ ] Add `npm run check`, `npm run typecheck`, and `npm test` scripts.
- [ ] Add initial package/source layout for core, cmux adapter, daemon, CLI, and web/dashboard placeholders.
- [ ] Add a minimal smoke test proving the test runner works.
- [ ] Add README notes explaining that the current Pi extension remains the live path.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

If the current Pi extension is touched, also run:

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

## Completion Criteria

- [x] New standalone project exists outside monolith.
- [ ] All baseline scripts pass.
- [ ] No Pi behavior changed.
- [ ] Validation results are recorded below.

## Notes

- Local repository exists at `/Users/muhammadabdul/work/alfred`.
- Private GitHub remote exists at `MakoSlay/alfred`.
- Package/tooling skeleton still needs to be implemented before this task is complete.

## Validation

_To be filled during implementation._

## Blockers

_None currently._
