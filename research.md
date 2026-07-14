# Research: Slack API for Local Personal Assistant (Attention/Todo Summarization)

## Summary
For a local personal assistant that summarizes attention items and todos, the recommended MVP approach is **Socket Mode + Bolt for Python** with an **undistributed single-workspace app** (classified as "internal customer-built"). This gives you real-time event ingestion, no public HTTP endpoint needed, and **full Tier 3 rate limits (50+ req/min, 1000 messages/req)** on `conversations.history`. Use a bot token with minimal scopes (`channels:history`, `groups:history`, `im:history`, `mpim:history`, `reactions:read`, `bookmarks:read`, `users:read`). Extract todos/attention items by subscribing to `message` events via the Events API, maintaining a local message cache, and periodically passing recent messages to an LLM with structured extraction prompts.

## Findings

### 1. Socket Mode vs Web API Polling: Socket Mode wins decisively for a local MVP

Socket Mode allows Slack to push events to your app over a persistent WebSocket connection. No public HTTP endpoint is required, and no polling is needed. Slack's own docs recommend Socket Mode for local development and behind-firewall scenarios. The Bolt Python SDK (`slack_bolt`) supports Socket Mode natively as of v1.2.0 with `SocketModeHandler`. [Slack: Comparing HTTP & Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode)

Key constraints: Slack limits concurrent WebSocket connections to **10 per app**. For a single-user local assistant this is irrelevant. Socket Mode is not allowed for Marketplace submission, but that doesn't apply here. [Slack: Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)

The alternative — Web API polling via `conversations.history` — hits the rate limit wall immediately (see Finding 2). Events API over HTTP (public endpoint) is for production deployments. [Slack: Bolt Python Socket Mode](https://docs.slack.dev/tools/bolt-python/concepts/socket-mode)

### 2. Rate Limits: CRITICAL — "internal customer-built" classification unlocks full rates

**The single most important finding for this project.** On May 29, 2025, Slack introduced draconian rate limits for non-Marketplace commercially distributed apps on `conversations.history` and `conversations.replies`: **1 request per minute, 15 messages max per request** (down from Tier 3: 50+ req/min, 1000 messages). As of March 3, 2026, the grace period ended and these limits apply to ALL non-Marketplace app installations. [Slack: Rate limit changes](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps)

**HOWEVER**, internal customer-built apps are **explicitly exempt**: they retain Tier 3 (50+ req/min, 1000 messages/req). An app you create and install ONLY in your own workspace — and never distribute commercially — is an "internal customer-built app." [Slack: Rate limits FAQ](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps#faq-internal)

General Web API tier summary:

| Tier | Rate | Example Methods |
|------|------|-----------------|
| Tier 1 | 1+/min | `conversations.history` (non-marketplace) |
| Tier 2 | 20+/min | `conversations.list`, `users.info` |
| Tier 3 | 50+/min | `conversations.history` (internal/marketplace) |
| Tier 4 | 100+/min | `conversations.members`, `users.list` |

Events API: 30,000 events per workspace per app per 60 minutes. Message posting: 1/sec per channel. [Slack: Rate limits overview](https://docs.slack.dev/apis/web-api/rate-limits)

**Practical impact for this project:** If you create the app via `api.slack.com/apps`, install it only to your workspace, and never list it commercially, you get full rate limits. The Events API via Socket Mode further sidesteps the polling rate limit entirely — messages stream in without consuming `conversations.history` quota.

### 3. Required Scopes: Minimal bot-token MVP set

For a personal assistant that reads messages, reactions, bookmarks, and user info across all conversation types:

**Bot Token Scopes (minimum):**
| Scope | Purpose |
|-------|---------|
| `channels:history` | Read public channel messages |
| `groups:history` | Read private channel messages |
| `im:history` | Read direct messages |
| `mpim:history` | Read group DMs |
| `reactions:read` | Read emoji reactions (attention signal) |
| `bookmarks:read` | Read saved bookmarks (attention signal) |
| `users:read` | Look up user names/profiles |

**User Token Scopes (if reminders are needed):**
| Scope | Purpose |
|-------|---------|
| `reminders:read` | List user's reminders (user token ONLY) |

[Slack: Scopes reference](https://docs.slack.dev/reference/scopes) | [Slack: reactions:read](https://docs.slack.dev/reference/scopes/reactions.read) | [Slack: bookmarks:read](https://docs.slack.dev/reference/scopes/bookmarks.read)

**Key constraint:** `reminders:read` and `reminders:write` only work with **user tokens** (`xoxp-`), not bot tokens. A bot cannot read a user's reminders. If you need reminders in the attention summary, you'll need OAuth with user token scopes, or you can skip reminders and rely on reactions/bookmarks/message patterns as proxies. [Slack: reminders.list](https://docs.slack.dev/reference/methods/reminders.list)

### 4. Security & Token Handling for Local Apps

**Token types needed:**
- `SLACK_BOT_TOKEN` (starts with `xoxb-`): For Web API calls and event subscriptions
- `SLACK_APP_TOKEN` (starts with `xapp-`): For establishing the Socket Mode WebSocket connection

**Best practices:**
- Store tokens in `.env` file; add `.env` to `.gitignore`
- Never hardcode tokens in source code
- Use minimum scopes (least privilege principle)
- For user tokens (if needed): use OAuth 2.0 flow; do OAuth server-side, not in client JS
- Enable token rotation if using long-lived tokens
- Verify incoming requests from Slack using signing secret (handled automatically by Bolt)
- Use app manifests (YAML/JSON) for reproducible, version-controlled app configuration

[Slack: Security best practices](https://slack.dev/security-practices-for-slack-apps/) | [Slack: Authentication overview](https://docs.slack.dev/authentication/)

**Local app consideration:** Since this runs on your machine only, the threat model is your local filesystem. The main risk is accidentally committing tokens to a public repo. Use `.env` + `.gitignore` and optionally OS-level keychain for the token. IP allowlisting is available for API token usage if desired: [Slack: Security concepts](https://docs.slack.dev/concepts/security)

### 5. Todo/Attention Extraction Patterns

**Architecture pattern (recommended):**
1. **Subscribe to `message` events** via Socket Mode/Events API → every message flows to your app in real time
2. **Persist messages locally** (SQLite or JSON file) with timestamps, channel, author, thread info
3. **Periodic batch extraction** (e.g., every 30 min or on demand): pull recent messages from local store, pass to LLM with structured prompt
4. **Attention signals to factor in:**
   - Direct @mentions of the user
   - Reactions (`:eyes:`, `:pushpin:`, `:white_check_mark:`, `:memo:`, custom emoji)
   - Bookmarks in channels the user belongs to
   - Thread replies where user participated
   - Messages containing request patterns: "can you...", "please...", "TODO:", "action item:", "@channel"
   - DMs to the user

**LLM extraction prompt patterns (from community practice):**
- Structured output: `[Owner] Action — Due [date] — Depends on [X]`
- Demand a source message line for each extracted item
- Mark inferred owners as `[SUGGESTED]`
- Models with large context windows (Gemini 3 Pro 1M tokens, Claude Sonnet 4 1M tokens) can process large batches in a single call

[AI Tools Guidebook: Action item extraction](https://aitoolsguidebook.com/en/articles/action-item-extraction-prompts/) | [Recal: Slack action items](https://tryrecal.com/slack-action-items) | [GitHub: Slack Task Extractor](https://github.com/rhapsodicpug/slack1)

**Alternative: Web API polling approach** (if you prefer not to run a persistent process):
- Call `conversations.history` periodically for each channel/DM
- With internal-app Tier 3 rates: can poll many channels efficiently
- Maintain a `latest` timestamp cursor per channel to fetch only new messages
- Paginate with cursor-based pagination (max 1000 per page)
- **Caveat:** Requires the bot to be explicitly added to each channel

### 6. App Manifest for Reproducible Setup

Slack supports YAML/JSON app manifests that capture the entire app configuration. This is strongly recommended for version control and reproducibility. [Slack: App manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests)

Example minimal manifest structure:
```yaml
display_information:
  name: Alfred Personal Assistant
features:
  bot_user:
    display_name: Alfred
oauth_config:
  scopes:
    bot:
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - reactions:read
      - bookmarks:read
      - users:read
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - reaction_added
```

### 7. Events API Event Types for Attention Signals

Relevant event types to subscribe to (only consume event quota, not Web API quota):
- `message.channels`, `message.groups`, `message.im`, `message.mpim` — new messages
- `reaction_added` — someone reacted (possible attention signal)
- `app_mention` — your bot was @mentioned directly

Events API limit: 30,000 deliveries per workspace per app per 60 minutes. [Slack: Rate limits](https://docs.slack.dev/apis/web-api/rate-limits#events)

## Sources

**Kept (high-quality, relevant):**
- Slack: Comparing HTTP & Socket Mode (https://docs.slack.dev/apis/events-api/comparing-http-socket-mode) — Official comparison, critical for architecture decision
- Slack: Rate limit changes for non-Marketplace apps (https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps) — The definitive source on the critical 2025/2026 rate limit changes and internal-app exemption
- Slack: Rate limits overview (https://docs.slack.dev/apis/web-api/rate-limits) — Full tier explanation and burst behavior
- Slack: Scopes reference (https://docs.slack.dev/reference/scopes) — All scope definitions
- Slack: Using Socket Mode (https://docs.slack.dev/apis/events-api/using-socket-mode) — Socket Mode setup
- Slack: Bolt Python Socket Mode (https://docs.slack.dev/tools/bolt-python/concepts/socket-mode) — SDK integration
- Slack: Security best practices (https://slack.dev/security-practices-for-slack-apps/) — Token handling, OAuth guidance
- Slack: App manifests (https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests) — Reproducible config
- Slack: conversations.history method (https://docs.slack.dev/reference/methods/conversations.history) — Rate limit tiers, pagination, scope requirements
- Slack: reminders.list / reminders:read (https://docs.slack.dev/reference/methods/reminders.list) — User-token-only constraint
- DEV Community: Slack Just Throttled Your OpenClaw Agent (https://dev.to/helen_mireille_47b02db70c/slack-just-throttled-your-openclaw-agent-you-probably-havent-noticed-yet-d4) — Practical impact analysis, workarounds (caching, pre-fetching, Events API approach)
- AI Tools Guidebook: Action Item Extraction (https://aitoolsguidebook.com/en/articles/action-item-extraction-prompts/) — Structured prompt patterns
- Slack: Bot and user tokens explained (https://slack.dev/two-keys-to-one-platform-understanding-bot-and-user-tokens/) — Token type selection guidance
- Slack: App distribution types (https://docs.slack.dev/app-management/distribution) — Internal vs distributed classification

**Dropped:**
- Knit blog / getknit.dev — Marketing content, redundant with official docs
- Salesforce Apex SDK docs — Irrelevant to Python/local app
- Matillion blog — Enterprise ETL, not relevant
- Paolo Belcastro Todoist/Zapier — Too narrow, platform-specific
- Sankalpcreat/Slack-Cli scopes.md — Unofficial, redundant with official docs
- Various .md mirrors of official docs — Redundant

## Gaps

1. **User token OAuth flow for local app:** The docs describe OAuth 2.0 for multi-workspace distributed apps. For a single-user local app needing a user token (for reminders), the simplest path would be a one-time OAuth flow. The exact steps for a single-workspace user token without a public redirect URI are not fully clear from docs alone — Socket Mode helps for events but not for the initial OAuth. A one-time token generation via the app dashboard may suffice but isn't documented as a primary path.

2. **Free workspace 90-day message history limit:** If the user is on a free Slack workspace, only 90 days of message history is searchable/retrievable. This may limit the scope of attention extraction. Paid plans remove this limit. [Slack: Free workspace limits](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces)

3. **Reminders API as user-only:** Confirmed that `reminders:read`/`reminders:write` require a user token (`xoxp-`), not a bot token. If summarizing reminders is a requirement, the project needs OAuth user token flow, which adds complexity. Alternatively, reminders could be skipped and reaction/bookmark signals used as proxies.

4. **"Internal customer-built" classification:** The docs clearly state internal apps are exempt from the new 1 req/min limit, but the exact mechanism of classification (is it just "never distribute the app" or is there a setting?) could use confirmation. From the docs: if the app is created, installed only in your workspace, and never submitted to Marketplace, it's internal.

5. **Message retention and storage:** If using the Events API approach with a local message store, the app only has messages from the point it started listening forward. Backfilling older history via `conversations.history` is rate-limited but feasible with internal-app Tier 3 rates (50+ req/min, 1000 per page).

## Supervisor coordination

No blocking decisions needed. The research is self-contained and covers all requested areas. The key architectural recommendation is clear: Socket Mode + Events API + local message cache + periodic LLM extraction, with the app classified as internal/undistributed to preserve full rate limits.

One **user-specific question** that cannot be answered from docs: **Does the user need reminder extraction specifically, or are reactions/bookmarks/@mentions sufficient as attention signals?** This determines whether user-token OAuth is needed.
