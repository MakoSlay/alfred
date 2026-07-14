# 005 — Slack Attention

Canonical details: `IMPLEMENTATION.md#005--slack-attention--redesigned-mvp`.

## Verdict

Previous design drifted into building a Slack data platform: background polling, encrypted SQLite, `keytar`, AES-GCM, retention jobs, and broad scope planning. That is follow-up work, not the MVP.

## Phase 1 Goal

Answer on demand: “what did I miss?” / “what needs my attention?” using verified Slack API capabilities, without persisting Slack message content.

## In Scope — Phase 1

- Read-only Slack client.
- Token/config loading with redaction.
- API/scope spike to prove how to fetch human-user mentions and reminders.
- On-demand query only.
- Rule-based attention ranking on fetched items.
- Todo candidates only; Apple Notes write remains confirmed and handled by Notes module.

## Out of Scope — Phase 1

- Background poller.
- Socket Mode.
- Encrypted SQLite cache.
- `keytar` dependency.
- AES-256-GCM field encryption.
- Retention jobs.
- DMs/private channels/search/files/canvases.
- External LLM classification by default.

## Critical Scope Note

Do not assume `app_mentions:read` solves human-user mentions. It may only cover mentions of the installed app/bot. The first implementation task is a small API/scope spike. MVP scopes must be documented after that spike, not guessed.

## Privacy Rules

- No raw Slack content in event store, dashboard state, history, logs, or errors.
- Slack results are ephemeral per request.
- External LLM summarization is disabled by default and requires explicit future opt-in.
- Redact tokens everywhere.

## Suggested Modules

```txt
src/alfred-2/slack/client.ts
src/alfred-2/slack/scopes.ts
src/alfred-2/slack/attention.ts
src/alfred-2/slack/privacy.ts
```

## Tests

- [ ] Token redaction.
- [ ] Auth/scope failure behavior.
- [ ] No raw Slack content persisted to event store/history/dashboard.
- [ ] Rule-based attention ranking on fixture payloads.
- [ ] External LLM path disabled by default.

## Completion Criteria

- [ ] Alfred can answer a narrow on-demand Slack attention question using verified scopes.
- [ ] Slack message content is not persisted.
- [ ] No background Slack system or encrypted cache is introduced in Phase 1.
