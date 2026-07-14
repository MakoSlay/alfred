# Alfred2 Dashboard Current Inventory

> Priority 0 — Capture what existed before replacement.
> Generated: 2026-07-03
> Historical baseline: Phase 1 replaced the inline dashboard on 2026-07-10. Use this document as the React parity checklist, not as a description of the current implementation.

---

## 1. Dashboard Features — UI Parity Checklist

The current dashboard at `src/alfred-2/dashboard.ts` is a single giant inline HTML string with embedded CSS and vanilla JS. It renders 6 pages via `data-page` toggling.

### 1.1 Pages

| Page | DOM id / selector | Purpose |
|------|-------------------|---------|
| Home (Radar) | `data-page="home"` | Hero greeting, waveform, ask input, KPI radar, recent responses |
| Memory | `data-page="memory"` | Profile facts CRUD with filter |
| Voice Studio | `data-page="voice"` | TTS provider, tone, wit, sarcasm, Fish/Edge advanced settings, test voice |
| Personality | `data-page="personality"` | Read-only identity, archetypes, address style, response style, spoken/screen output contracts, TTS style controls |
| Safety | `data-page="safety"` | Auto-confirm toggle, mute with duration, undo history table, clear undo, telemetry stats |
| Tools | `data-page="tools"` | Tool registry table with filter, "Ask Alfred" button |

### 1.2 Feature Checklist

- [x] Session ID display (top bar badge)
- [x] Muted/speaking state (voice dot badge, muted-until display)
- [x] Auto-confirm state (toggle button, badge)
- [x] Pending confirmation count (radar KPI, posture sidebar)
- [x] Session token count (radar KPI — cumulative)
- [x] Current context tokens (radar KPI)
- [x] Tool round count (radar KPI)
- [x] Memory turn count (safety telemetry)
- [x] Profile facts list (memory page table)
- [x] Add profile fact (form with key, value, category dropdown)
- [x] Delete profile fact (via "forget <key>" ask flow — each row has a delete button that calls `ask("forget ...")`)
- [x] Filter profile facts (text input, client-side filter on key/value/category)
- [x] Fact count badges (nav sidebar, memory page header, hero KPI)
- [x] Undo history list (safety page table with timestamp, path, tool, restore button)
- [x] Restore undo entry (POST `/dashboard/undo/:id`)
- [x] Clear undo history (DELETE `/dashboard/undo`)
- [x] Undo count badges (nav sidebar, safety page header, hero KPI)
- [x] Tool registry list (tools page cards with name, description, confirmation level, schema JSON)
- [x] Tool count badges (nav sidebar, hero KPI)
- [x] Tool filter (text input, client-side filter)
- [x] Ask "what can you do?" (quick prompt pill + tools page button)
- [x] Quick ask input (hero command box + Enter key)
- [x] Quick prompt pills (Needs attention, Capabilities, Refresh context, Session summary)
- [x] Voice/TTS settings form:
  - [x] Provider dropdown (fish/edge/macos)
  - [x] Fallback provider dropdown (edge/macos/none)
  - [x] Fish API key status indicator (set/missing)
  - [x] Fish voice ID input
  - [x] Fish model input
  - [x] Fish speed (number, 0.5–2.0)
  - [x] Edge voice input
  - [x] Edge rate input
  - [x] Tone/style dropdown (auto/neutral/warm/calm/dry/reassuring/sarcastic)
  - [x] Wit level dropdown (off/light/medium)
  - [x] Sarcasm level dropdown (off/light/medium)
  - [x] Save voice button (POST `/dashboard/tts`)
  - [x] Test voice button (POST `/dashboard/tts/test`)
  - [x] TTS error display
- [x] Dashboard polling via `GET /dashboard/state` (5-second interval)
- [x] Recent responses list (home page, client-side from `/dashboard/state`)
- [x] Wake listener status (sidebar: provider, running state, mic active, detail, last error)
- [x] Wellness/pr break status (implicit via sidebar)
- [x] Four visual vibe trials (estate, cave, concierge — stored in localStorage)
- [x] Page navigation persistence (localStorage)
- [x] Animated waveform (CSS-only, 8-bar wave with staggered animation)
- [x] Refresh button (manual polling trigger)
- [x] Scrollback / recent responses visible inline
- [x] PR watcher status (via `/dashboard/state`)

### 1.3 Missing / Not Yet Implemented

- [ ] Real voice input from browser (no mic button, no Web Speech API integration)
- [ ] Live event stream (polling only, no SSE)
- [ ] Knowledge/RAG management UI
- [ ] Work Radar page (no dedicated page — currently just hero KPIs)
- [ ] Tool grouped by toolkit (flat list)
- [ ] Memory tabs (Profile / Session / Knowledge — only Profile facts exist)
- [ ] Voice overlay/waveform visualizer for mic input
- [ ] In-browser TTS playback (server-side `say`/`afplay` only)
- [ ] Interrupt handling for voice
- [ ] Memory provenance display
- [ ] Confirmation approval UI in dashboard (confirmations are CLI/voice-only)

---

## 2. API Endpoints

All served by `src/alfred-2/server.ts`.

### 2.1 Current Endpoints

| Method | Path | Purpose | Response |
|--------|------|---------|----------|
| GET | `/health` | Health check | `{ ok: true, health: "ok" }` |
| GET | `/dashboard` | Full dashboard page | `text/html` — inline rendered HTML |
| GET | `/dashboard/state` | Dashboard state JSON | `{ ok: true, ...DashboardState }` |
| GET | `/tools` | Tool contracts | `{ ok: true, count, names, contracts: DashboardToolContract[] }` |
| GET | `/dashboard/tts` | TTS settings read | `{ ok: true, tts: PublicTtsSettings }` |
| POST | `/dashboard/tts` | TTS settings update | `{ ok: true, tts: PublicTtsSettings }` |
| POST | `/dashboard/tts/test` | Test TTS (server-side speak) | `{ ok: boolean, tts, error? }` |
| POST | `/dashboard/undo/:id` | Restore specific undo entry | `{ ok: true, restored: true, tool, id, originalPath }` |
| DELETE | `/dashboard/undo` | Clear all undo snapshots | `{ ok: true, removed: number }` |
| POST | `/dashboard/facts` | Add profile fact | `{ ok: true, fact: UserFact }` |
| POST | `/mute` | Mute with duration | `{ ok: true, speech, displayText, mutedUntil }` |
| POST | `/unmute` | Unmute | `{ ok: true, speech, displayText, mutedUntil }` |
| GET | `/mute/status` | Mute status | `{ ok: true, speech, displayText, muted }` |
| POST | `/ask` | Main ask (also `/` and `/handle` for compat) | `{ ok: true, requestId, sessionId, speech, displayText, ...full response }` |

### 2.2 `/dashboard/state` Response Shape

```ts
interface DashboardState {
  sessionId: string;
  muted: boolean;
  mutedUntil: string | null;
  autoConfirm: boolean;
  sessionTokens: number;          // cumulative total
  currentContextTokens: number;   // current prompt estimate
  maxContextTokens: number;       // peak context seen
  toolRounds: number;             // total tool rounds this session
  pendingConfirmations: number;
  profileFacts: Array<{ key: string; value: string; category: string; updatedAt: string }>;
  memoryTurns: number;
  undoCount: number;
  undoHistory: UndoEntry[];
  tools: { count: number; names: string[] };
  tts: PublicTtsSettings;
  personality: AlfredPersonalityConfig;
  listener: Alfred2ListenerStatus;
  prWatcher: { enabled: false } | ({ enabled: true; intervalMs: number } & PrWatcherStatus);
  recentResponses: DashboardRecentResponse[];
  lastUpdated: string;
}
```

### 2.3 `/ask` Request Shape

```ts
POST /ask
Content-Type: application/json

{
  text: string;           // required
  requestId?: string;     // client-generated or server-generated
  confirm?: boolean;      // force-confirm a pending tool
  confirmationId?: string;
}
```

### 2.4 `/ask` Response Shape (full)

```ts
{
  ok: boolean;
  requestId: string;
  sessionId: string;
  speech: string;
  displayText: string;
  command?: string;
  executed: boolean;
  requiresConfirmation: boolean;
  confirmationPrompt?: string;
  confirmationId?: string;
  commandResult?: { ok: boolean; stdout: string; stderr: string; exitCode: number };
  toolResults: Array<{ toolCallId: string; tool: string; success: boolean; text: string; ... }>;
  muted: boolean;
  timing: { contextMs: number; agentMs: number; speechFormatterMs: number; totalMs: number };
  tokens: { context: number; currentPrompt: number; maxPrompt: number; saved: number; llm: TokenUsage; speechFormatter: {...}; session: number };
  trace: { sessionId, requestId, source, toolCount, toolRoundsTotal, retries, usage, speechFormatter, rag, events };
  handoffPath?: string;
  memory: { turns: number; tokens: number; currentContextTokens: number; maxContextTokens: number; pendingConfirmations: number };
}
```

---

## 3. Tool Registry — Current Tool List

Defined in `src/alfred-2/tool-types.ts` (`ALFRED_TOOL_NAMES`) and `src/alfred-2/server.ts` (`TOOL_CONTRACTS`).

### 3.1 Registered Tool Names (18 tools)

| # | Tool Name | Risk Level | Confirmation | Mutates Local State | External Service | In Dashboard UI |
|---|-----------|-----------|-------------|---------------------|-----------------|-----------------|
| 1 | `bash` | dynamic (regex classified) | mixed | yes (if mutation) | no | yes |
| 2 | `read_file` | `read` | `none` | no | no | yes |
| 3 | `write_file` | `mutation` | `confirm` | yes (creates/overwrites) | no | yes |
| 4 | `edit_file` | `mutation` | `confirm` | yes (mutates) | no | yes |
| 5 | `web_search` | `external` | `none` | no | yes (Exa) | yes |
| 6 | `fetch_content` | `external` | `none` | no | yes (fetch) | yes |
| 7 | `remember` | `mutation` | `none` | yes (profile.json) | no | yes |
| 8 | `recall` | `read` | `none` | no | no | yes |
| 9 | `set_voice_settings` | `mutation` | `none` | yes (runtime + env file) | no | yes |
| 10 | `refresh_context` | `read` | `none` | no | no | yes |
| 11 | `inspect_session` | `read` | `none` | no | yes (cmux) | yes |
| 12 | `gmail_search` | `external` | `none` | no | yes (Google) | yes |
| 13 | `gmail_read` | `external` | `none` | no | yes (Google) | yes |
| 14 | `calendar_today` | `external` | `none` | no | yes (Google) | yes |
| 15 | `calendar_upcoming` | `external` | `none` | no | yes (Google) | yes |
| 16 | `docs_search` | `external` | `none` | no | yes (Google) | yes |
| 17 | `docs_read` | `external` | `none` | no | yes (Google) | yes |
| 18 | `log_break` | `mutation` | `none` | yes (wellness state) | no | yes |

### 3.2 Bash Risk Classification Rules (from `src/alfred-2/risk.ts`)

| Category | Examples | Risk | Confirmation |
|----------|----------|------|-------------|
| Blocked paths | `/etc/*`, `~/.ssh/*`, `~/.aws/*`, `.env` | `destructive` | `blocked` |
| Destructive git | `git push`, `git reset --hard`, `git clean`, `push --force` | `destructive` | `explicit` |
| Destructive bash | `rm`, `sudo`, `kill`, `curl \| sh`, redirect to non-null | `destructive` | `explicit` |
| Git mutations | `git add`, `git commit`, `git checkout`, `git pull`, `git merge` | `mutation` | `confirm` |
| Package mutations | `npm install`, `pip install`, `brew install` | `mutation` | `confirm` |
| General mutations | `mv`, `cp`, `mkdir`, redirects, `tee` | `mutation` | `confirm` |
| Read-only git | `git status`, `git diff`, `git log`, `gh pr view` | `read` | `none` |
| Read-only diagnostics | `npm test`, `npm run lint`, `tsc`, `pytest`, `ruff` | `read` | `none` |
| Default (e.g., `ls`, `echo`, `cat`, `pwd`) | unclassified commands | `read` | `none` |

### 3.3 Deferred Tools (not yet implemented)

From `tool-types.ts` `DEFERRED_ALFRED_TOOLS`:
- `subagents`
- `intercom`
- `vision_video_analysis`
- `long_running_background_workers`

---

## 4. Confirmation State

Managed by `PendingConfirmationStore` in `src/alfred-2/confirmation.ts`.

### 4.1 Store Properties

- In-memory `Map<string, PendingConfirmation>`
- Auto-expiry: 5 min default, 1 min for destructive
- SHA256 integrity hashing of stored payloads
- Deterministic text previews for display

### 4.2 Confirmation Flow

1. LLM returns a tool call
2. `classifyToolRisk()` determines risk/confirmation level
3. If confirmation needed: stored in `confirmationStore.add()`
4. User responds via voice CLI: "yes", "confirm", "approve", "go ahead", "yes to all", "no", "cancel"
5. Voice confirmation matches: `"yes"` with exactly one pending confirmation (`getSole()`)
6. Confirmation routed to next LLM call with `confirm: true` + `confirmationId`
7. Auto-confirm mode (`autoConfirm = true`) bypasses confirmations for non-destructive tools

### 4.3 Available in Dashboard

- Pending confirmation count displayed in radar KPI and sidebar
- No UI for approving/denying individual confirmations from dashboard (CLI/voice only)

---

## 5. Voice/TTS Settings — Full Contract

### 5.1 Settings Model

```ts
interface PublicTtsSettings {
  provider: "fish" | "edge" | "macos";
  fallbackProvider: "edge" | "macos" | "none";
  hasFishApiKey: boolean;
  fishVoiceId: string;
  fishModel: string;          // default: "s2.1-pro"
  fishSpeed: number;          // 0.5–2.0, default: 1.0
  edgeVoice: string;          // default: "en-GB-ThomasNeural"
  edgeRate: string;           // default: "+10%"
  macosVoice: string;
  speechStyle: "auto" | "neutral" | "warm" | "calm" | "dry" | "reassuring" | "sarcastic";
  witLevel: "off" | "light" | "medium";
  sarcasmLevel: "off" | "light" | "medium";
  lastProvider: "fish" | "edge" | "macos" | null;
  lastError: string | null;
}
```

### 5.2 Provider Fallback Chain

- Try primary provider → try fallback → try macos (always available)
- Mute/suppression state checked before any speech
- Speech auto-aborts previous speech (AbortController)

### 5.3 Speech Suppression

- Muted state: suppresses all speech
- Microphone active: pauses speech (poll-waits until mic releases)
- Microphone state from activity sampler

### 5.4 Current Limitation

- `speak()` uses server-side `afplay` on macOS — audio plays through server, not browser
- No browser-playable audio endpoint
- No synthesis-only endpoint returning audio buffer

---

## 6. Profile Facts — CRUD Contract

### 6.1 Storage

```txt
~/.alfred/profile.json
```

### 6.2 Data Model

```ts
interface UserFact {
  key: string;
  value: string;
  category: "preference" | "identity" | "context" | "note";
  addedAt: string;
  updatedAt: string;
  source: "user" | "observed";
}
```

### 6.3 Operations

| Operation | Code Path | Via |
|-----------|-----------|-----|
| Add/update fact | `rememberFact(key, value, category, source)` | LLM tool `remember` or dashboard form POST `/dashboard/facts` |
| Read facts | `recallFact(key?)` | LLM tool `recall` or dashboard state |
| Delete fact | `forgetFact(key)` | LLM tool pattern match "forget <key>" or dashboard delete button |
| Format for context | `formatProfileForContext()` | Injected into system prompt |

### 6.4 Current Limitations

- No provenance beyond `source: "user" | "observed"`
- No `requestId` or `turnId` link
- No confidence score
- No session memory (separate from profile)

---

## 7. Undo System

### 7.1 Storage

```txt
~/.alfred/undo/
  undo-index.json
  undo-<timestamp>-<random>/
```

### 7.2 Data Model

```ts
interface UndoEntry {
  id: string;
  originalPath: string;
  backupPath: string;
  timestamp: string;
  tool: string;
  preview: string;  // e.g. "Backup of server.ts before edit_file"
}
```

### 7.3 Operations

| Operation | Endpoint / Code | Description |
|-----------|-----------------|-------------|
| Save backup | `saveUndoBackup(filePath, tool)` | Copies file to undo dir before mutation |
| Record entry | `recordUndo(entry)` | Adds to index, caps at 50 entries |
| List | `getUndoHistory()` | Returns sorted (most recent first) |
| Restore by id | `POST /dashboard/undo/:id` → `undoById(id)` | Restores single entry |
| Restore by path | `undoByOriginalPath(path)` | Used for "undo last" |
| Restore last | `undoLastEdit()` | Undoes most recent entry |
| Clear all | `DELETE /dashboard/undo` → `clearUndoHistory()` | Removes all backups and index |

---

## 8. Session Memory

### 8.1 Model

```ts
interface SessionMemory {
  turns: ConversationTurn[];       // ring buffer, max 10
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeTotalTokens: number;
  currentContextTokens: number;
  maxContextTokens: number;
  warnThreshold: number;           // default 80,000
  handoffThreshold: number;        // default 100,000
}

interface ConversationTurn {
  userText: string;
  finalSpeech: string;
  toolsUsed: string[];
  workspaceHint: string;
  shortOutcome: string;
}
```

### 8.2 Operations

- Add turn: `addTurn(memory, turn, maxTurns?)`
- Token accounting: `addTokens(memory, usage)`, `updateCurrentContextTokens(memory, tokens)`
- Threshold checks: `shouldWarnForContext()`, `shouldHandoffForContext()`
- Format for context: `formatConversationForContext(memory)`
- Handoff generation: `generateHandoffContent({...})` → markdown

### 8.3 Handoff Storage

```txt
~/.alfred/handoffs/
  YYYY-MM-DDTHH-mm-ss-session-<sessionId>-request-<requestId>.md
```

---

## 9. Personality Configuration

### 9.1 Model (read-only from dashboard)

```ts
interface AlfredPersonalityConfig {
  identity: string;
  archetypes: string[];
  addressStyle: string;
  responseStyle: string[];
  spokenOutputContract: string[];
  screenOutputContract: string[];
  ttsStyleControls: string[];
}
```

### 9.2 Key Behaviors

- Identity: "private local butler and desktop assistant, not a robot or search engine"
- Address: ends with "sir." naturally
- Spoken contract: no Markdown, no code fences, no emoji, no file paths in speech
- Screen contract: displayText may contain structured details
- TTS controls: style/tone, wit level, sarcasm level

---

## 10. Activity/Watcher State

### 10.1 Activity Sampler

- `src/alfred-2/activity/sampler.ts`
- Polls microphone state, idle time, meeting detection
- Provides `getSnapshot()` for wellness watcher and speech suppression

### 10.2 Wellness Watcher

- `src/alfred-2/watchers/wellness.ts`
- Tracks work duration, break reminders
- Commands: `snooze break`, `acknowledge break`, `wellness status`
- State persisted across restarts

### 10.3 PR Notification Watcher

- `src/alfred-2/watchers/pr-notifications.ts`
- Polls for open PRs needing attention
- Conditionally enabled via env

---

## 11. Dashboard UI Client-Side State

The current dashboard manages state entirely client-side via polling:

```js
// state refreshed every 5 seconds
setInterval(refresh, REFRESH_MS);

// local state variables
current = { autoConfirm, muted, facts, tools, responses, tts, personality, listener };

// local storage persisted
localStorage.getItem("alfred2-vibe")   // visual theme
localStorage.getItem("alfred2-page")   // active page
```

### 11.1 JavaScript API Surface

```js
api(path, options)           // fetch wrapper, returns JSON
ask(text)                    // POST /ask wrapper
refresh()                    // GET /dashboard/state + GET /tools
switchPage(page)             // data-page toggling
switchVibe(vibe)             // data-vibe toggling + label updates
renderFacts(facts)           // table render
renderUndo(entries)          // table render
renderTools(payload)         // cards render
renderRecentResponses()      // timeline render
updateVoiceState(tts)        // form sync + badge update
renderPersonality(personality) // read-only renders
updateListenerState(listener)  // sidebar updates
updateState(s)               // dispatch from /dashboard/state
saveVoiceSettings()          // POST /dashboard/tts
testVoice()                  // POST /dashboard/tts/test
voicePayload()               // extract form values
```

### 11.2 Event Handling

- Page navigation: click `[data-page-target]` buttons
- Theme switching: click `[data-vibe]` buttons
- Fact form: submit → POST `/dashboard/facts`
- Ask input: Enter or button → `ask(text)` → `refresh()`
- Quick prompts: click `[data-prompt]` → fills ask input and submits
- Auto-confirm toggle: sends "yes to all" / "stop auto confirm" to `/ask`
- Mute toggle: POST `/mute` or `/unmute`
- Clear undo: DELETE `/dashboard/undo`
- Save voice: POST `/dashboard/tts`
- Test voice: POST `/dashboard/tts/test`
- Fact filter: `input` on `#fact-filter`
- Tool filter: `input` on `#tool-filter`

---

## 12. Summary for Phase 1 Migration

### Must preserve:

- All 13 API endpoints with same contracts
- All dashboard features listed in §1.2
- 5-second polling should continue working (can be supplemented by SSE later)
- localStorage persistence for active page and theme
- Tool contracts served under `/tools`
- Confirmation count display
- Undo/restore/clear flow
- Profile fact CRUD
- TTS settings edit/save/test
- All 18 tool definitions with risk classifications
- Leadership data display (muted, auto-confirm, pending)

### Must add in Phase 1:

- Real React frontend app served from `web/`
- Vite build pipeline
- `/dashboard` serves built React app
- `/dashboard/assets/*` serves static assets
- `/dashboard/state` unchanged (hydration)
- Clean component architecture (not monolithic HTML string)

### Can defer:

- SSE event stream (Phase 2)
- Browser voice input (Phase 2)
- Knowledge/RAG UI (Phase 5)
- Work Radar page (Phase 7)
- Toolkit grouping (Phase 8)
- Visual identity finalization (Phase 9)
