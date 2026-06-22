# Alfred Local Persistence and Retention

## Decision

Alfred's first durable store uses a local app directory with JSON files:

```text
~/.alfred/
  events.jsonl     # redacted audit events only
  targets.json     # sanitized target memory
  metadata.json    # storage version and retention policy summary
```

`ALFRED_STORAGE_DIR` may point the daemon at a different local app directory. Tests and one-off runs can also pass `storageDir: null` to keep state process-only.

SQLite is deferred. Alfred currently needs append-friendly audit history and small target metadata; it does not yet need SQL queries, migrations, or concurrent writers. JSONL is easier to inspect and reset while the daemon storage model is still small.

## Retention and Redaction Rules

| Data class | Stored? | Rule |
| --- | --- | --- |
| Events with `retention.policy: "short"` | Yes | Stored in `events.jsonl` until `expiresAt`, then pruned on startup/load. |
| Events with `retention.policy: "manual"` | Yes | Stored until operator reset/delete. |
| Events with `retention.policy: "session"` or `"ephemeral"` | No | Kept in process memory only. |
| Pending drafts | No | Draft text remains session-only; restart clears pending drafts. |
| Target memory | Yes | Stored in `targets.json` with core target fields only. Target `metadata` is intentionally omitted. |
| Loop runtime state | No | Active loop execution state remains session-only for now. Loop lifecycle audit events are persisted when they use `short`/`manual` retention. |
| Raw transcripts/session files/provider raw output | No | Never persisted by default. |
| Event `data` payloads | No | Omitted from persisted events to avoid durable raw planner/provider/user payloads. |

Persisted events keep summaries, event kind, timestamps, source identity summary, sanitized target summary, action/loop IDs, redaction metadata, and retention metadata. They do not store draft text or raw transcript-like content.

## File Permissions

The JSON storage adapter creates the app directory with mode `0700` and files with mode `0600` where the filesystem supports POSIX permissions. Permission setting is best-effort because some local filesystems ignore `chmod`.

## Startup and Pruning Behavior

On daemon startup, Alfred:

1. Creates the app directory if needed.
2. Loads valid persisted `short`/`manual` events.
3. Loads sanitized target memory.
4. Skips corrupt/invalid records without failing startup.
5. Prunes expired events and rewrites `events.jsonl`.
6. Starts with no pending drafts and no resumed active loop runtime.

If storage errors occur, `/state` reports `health: "degraded"` with `storageWarnings`; request handling continues best-effort.

## Backup, Delete, and Reset

Backup:

```bash
cp -R ~/.alfred ~/.alfred.backup.$(date +%Y%m%d%H%M%S)
```

Delete/reset all persisted Alfred state:

```bash
rm -rf ~/.alfred
```

Delete only persisted event history while keeping target memory:

```bash
rm -f ~/.alfred/events.jsonl
```

Delete only target memory:

```bash
rm -f ~/.alfred/targets.json
```

Use a disposable store for local smoke tests:

```bash
ALFRED_STORAGE_DIR=$(mktemp -d) npm run daemon
```
