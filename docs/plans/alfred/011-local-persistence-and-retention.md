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

## Checklist

- [ ] Write a short storage decision note comparing JSONL, SQLite, and app-dir layout for Alfred's current needs.
- [ ] Define retention/redaction rules for events, target memory, loop state, pending drafts, and transcript-like data.
- [ ] Implement the selected storage adapter behind a daemon-owned interface.
- [ ] Persist only approved fields and avoid raw secrets/transcripts unless explicitly redacted and justified.
- [ ] Load persisted state on daemon startup and prune expired records.
- [ ] Add tests for persistence round trip, retention pruning, redaction behavior, and corrupt-store handling.
- [ ] Document backup/delete/reset procedures for local operators.

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

- [ ] Alfred has an explicit local storage decision and documented app-dir path.
- [ ] Persisted state survives daemon restart where intended.
- [ ] Pending drafts are either deliberately session-only or persisted with a documented safety rationale.
- [ ] Retention pruning and redaction are tested.
- [ ] No committed fixtures contain real transcripts or tokens.
- [ ] Standalone Alfred gates pass.

## Notes

- Treat transcript/history data as sensitive local data even when it originated on localhost.
- The safest initial default is to persist metadata and short audit events, not raw terminal contents.

## Blockers

- Should follow 008 so daemon lifecycle and startup paths are stable.
- Loop-state persistence depends on task 010's contract shape and should be explicitly deferred if 010 is not ready.
