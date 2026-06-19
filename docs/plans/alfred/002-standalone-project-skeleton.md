# 002 - Standalone Project Skeleton

## Goal

Create the new standalone Alfred project outside the Diversio monolith.

## Scope

Initialize `/Users/muhammadabdul/work/alfred` with TypeScript tooling, package scripts, tests, and an initial source layout. Do not move the live Pi extension yet.

## Checklist

- [x] Create `/Users/muhammadabdul/work/alfred` as a separate git repository outside monolith.
- [x] Add package metadata and TypeScript configuration.
- [x] Add `npm run check`, `npm run typecheck`, and `npm test` scripts.
- [x] Add initial package/source layout for core, cmux adapter, daemon, CLI, and web/dashboard placeholders.
- [x] Add a minimal smoke test proving the test runner works.
- [x] Add README notes explaining that the current Pi extension remains the live path.

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
- [x] All baseline scripts pass.
- [x] No Pi behavior changed.
- [x] Validation results are recorded below.

## Notes

- Local repository exists at `/Users/muhammadabdul/work/alfred`.
- Private GitHub remote exists at `MakoSlay/alfred`.
- Package/tooling skeleton is implemented with Node >=22.12, TypeScript, and Node's built-in test runner.
- `src/contracts/` contains executable TypeScript versions of the Task 001 runtime contracts plus small helpers.
- `src/testing/fixtures.ts` contains representative Pi, CLI, and Powerco/Power Code draft-confirm fixtures.
- Placeholder modules exist for `src/core/`, `src/cmux/`, `src/daemon/`, `src/cli/`, and `src/web/` so later tasks have stable landing zones.
- `README.md` now documents the baseline commands and repeats that the Pi extension remains the live `/alfred` path during parallel development.

## Validation

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

All passed. `npm test` ran 3 Node test cases covering contract export, the Powerco pending-draft fixture, and read-vs-send capability helpers.

The Pi extension repo was not modified, so Pi extension gates were not required.

## Blockers

_None currently._
