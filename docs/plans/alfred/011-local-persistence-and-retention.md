# 011 - Local Persistence and Retention

## Goal

Choose and implement Alfred's first local persistence model for event history, target memory, and any available loop state without storing sensitive transcripts unsafely.

## Dependencies

- Requires: 008
- Related: 010 for loop-state persistence shape and 012 for persisted history display
- Blocks: None

## Scope

Move beyond process-only memory for daemon state where appropriate, but make retention/redaction rules explicit before writing durable data.

**In scope:**

- Storage decision record: JSONL events, SQLite, or another local app-dir model.
- Local app directory selection and file permission expectations.
- Persisted event history with retention limits.
- Persisted target memory and daemon-owned loop state only if task 010's shape is available; otherwise document loop-state persistence as deferred.
- Clear decision on whether pending drafts remain session-only.
- Redaction/retention tests.

**Out of scope:**

- Cloud sync.
- Multi-device identity.
- Storing raw terminal transcripts by default.
- Full database migrations beyond what is needed for local development.

## Initial Storage Direction

Use this default unless implementation evidence shows it is unsafe:

- App directory: `~/.alfred/` by default, overrideable later by env/config if needed.
- Event log: JSONL file such as `~/.alfred/events.jsonl` for redacted audit events only.
- Metadata: small JSON files for target memory and storage metadata.
- Pending drafts: session-only for the first persistence pass; do not persist draft text unless a later task documents a safety rationale.
- Raw transcripts/session files: never persisted by default.
- SQLite is deferred until query complexity, migrations, or concurrency needs justify it.

## Checklist

- [x] Write a short storage decision note comparing JSONL, SQLite, and app-dir layout for Alfred's current needs, starting from the app-dir JSONL default above.
- [x] Define retention/redaction rules for events, target memory, loop state, pending drafts, and transcript-like data.
- [x] Implement the selected storage adapter behind a daemon-owned interface.
- [x] Persist only approved fields and avoid raw secrets/transcripts unless explicitly redacted and justified.
- [x] Load persisted state on daemon startup and prune expired records.
- [x] Add tests for persistence round trip, retention pruning, redaction behavior, and corrupt-store handling.
- [x] Document backup/delete/reset procedures for local operators.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

Manual smoke after implementation:

```bash
# Start daemon, create events/drafts as applicable, stop daemon, restart daemon,
# then verify only intended state survives and expired/sensitive state does not.
```

## Completion Criteria

- [x] Alfred has an explicit local storage decision and documented app-dir path.
- [x] Persisted state survives daemon restart where intended.
- [x] Pending drafts are either deliberately session-only or persisted with a documented safety rationale.
- [x] Retention pruning and redaction are tested.
- [x] No committed fixtures contain real transcripts or tokens.
- [x] Standalone Alfred gates pass.

## Notes

- Treat transcript/history data as sensitive local data even when it originated on localhost.
- The safest initial default is to persist metadata and short audit events, not raw terminal contents.
- If task 010 is not complete when 011 starts, explicitly defer loop-state persistence and persist only non-loop metadata/events.
- Storage decision/operator procedures are documented in `docs/storage/local-persistence.md`.
- Loop runtime state remains session-only in this pass; loop lifecycle audit events persist when their retention policy allows it.

## Validation Evidence

- 2026-06-22: `npm run typecheck` passed.
- 2026-06-22: `npm test` passed, 63 tests.

## Blockers

_None currently; loop-state persistence should be deferred if task 010's contract shape is not ready._
