# Alfred Standalone Product Roadmap

## Decision: What “Standalone Product” Means

For now, **standalone** means:

> Alfred is architecturally decoupled from cmux and becomes its own local-first assistant app. It is not being productized for external users yet.

This roadmap optimizes for **one primary user / one local machine first**. That changes several technical decisions:

- Prefer hardcoded/simple local defaults over generic provider abstractions.
- Avoid building marketplace-style configurability before it is needed.
- Keep auth out of scope while the app is localhost-only.
- Treat cmux as one integration/toolkit, not Alfred’s identity.
- Build a clean architecture that could become productized later, but do not pay that cost now.

If Alfred later needs to run for other users or from non-local devices, revisit:

- auth
- per-user settings
- provider configuration UI
- remote access
- encrypted storage
- permissions model
- onboarding/setup flows

---

## North Star

Alfred should become:

> A standalone local-first AI butler app with voice, memory, RAG, tools, safety, and work awareness. cmux is one integration, not the product.

The immediate goal is to move from:

> daemon with dashboard bolted on

into:

> properly structured local app with a real frontend, live voice UX, memory/RAG, work radar, and scalable toolkits.

Visual polish comes last. The architecture and behavior must come first.

---

## Current Constraints and Principles

### Keep Localhost-Only For Now

Alfred stays bound to localhost. No auth work unless we decide Alfred must be reachable from another device.

### Do Not Keep Expanding `dashboard.ts`

`src/alfred-2/dashboard.ts` should stop growing. It served its purpose, but it is now the wrong abstraction.

### cmux Is an Integration

cmux remains valuable, but Alfred should be able to grow beyond it.

Correct framing:

```txt
Alfred -> Work Toolkit -> cmux adapter
```

Incorrect framing:

```txt
Alfred == cmux dashboard
```

### Avoid Premature Generalization

Do not build multi-provider abstractions just because other products have them. Add abstraction when Alfred has two real implementations to support.

### Reuse Concepts, Not Code

Reference repos are inspiration only:

```txt
reference-repos/rezaulhreza-jarvis
reference-repos/leon-ai-leon
reference-repos/thevickypedia-Jarvis
```

Do not copy large chunks blindly.

---

## Phase 0 — Inventory Current Behavior Before Replacing Anything

**Status: complete.** The migration baseline is captured in `docs/plans/alfred-dashboard-current-inventory.md`.

### Goal

Before deleting or replacing the inline dashboard, capture what it currently does so Phase 1 does not regress behavior accidentally.

### Inventory Current Dashboard Features

From current Alfred2 dashboard:

- session ID display
- muted / speaking state
- muted-until display
- auto-confirm state
- pending confirmation count
- session token count
- tool round count
- memory turn count
- profile facts list
- add profile fact
- delete profile fact via Ask flow
- filter profile facts
- undo history list
- restore undo entry
- clear undo history
- tool registry list
- ask “what can you do?”
- quick ask input
- voice/TTS settings:
  - provider
  - fallback provider
  - Fish voice ID
  - Fish model
  - Fish speed
  - Edge voice
  - Edge rate
  - tone/style
  - wit level
  - sarcasm level
  - save voice
  - test voice
- dashboard polling via `/dashboard/state`
- `/tools` registry fetch
- `/ask` command submission

### Inventory Current Tool List and Risk

Before toolkit migration, capture:

- registered tool names
- tool schemas
- confirmation/risk classification
- whether each tool mutates local state
- whether each tool calls external services
- whether each tool should appear in the UI

This matters because Phase 8 should fold risk into the toolkit registry instead of maintaining a separate risk model by hand.

### Done When

- A checklist exists in the plan or a separate inventory doc.
- React migration has explicit parity targets.
- Tool registry migration has explicit parity targets.

---

## Phase 1 — Replace Inline Dashboard With a Real App Shell

**Status: implemented on 2026-07-10.** The React/Vite app lives under `web/`; `src/alfred-2/dashboard-assets.ts` serves the built app and hashed assets; the old inline `src/alfred-2/dashboard.ts` was removed. Existing APIs remain unchanged and `/dashboard/state` remains the hydration source.

### Goal

Move from giant inline HTML:

```txt
src/alfred-2/dashboard.ts
```

to a real frontend app.

### Add

```txt
web/
  package.json
  vite.config.ts
  src/
    App.tsx
    api/client.ts
    pages/
      RadarPage.tsx
      VoicePage.tsx
      MemoryPage.tsx
      SafetyPage.tsx
      ToolsPage.tsx
      SettingsPage.tsx
    components/
      AppShell.tsx
      CommandBox.tsx
      StatusPill.tsx
      AlfredWaveform.tsx
```

### Backend Changes

Update:

```txt
src/alfred-2/server.ts
```

Serve:

```txt
GET /dashboard              -> built React app
GET /dashboard/assets/*     -> built assets
GET /dashboard/state        -> hydration/current JSON state
GET /tools                  -> current tool registry
POST /ask                   -> existing ask endpoint
```

### Hydration Contract

`/dashboard/state` is the source of truth on:

- initial app load
- reconnect after event stream disconnect
- manual refresh

The event stream in later phases is not the only state source. It is a live update channel layered on top of `/dashboard/state`.

### Done When

- `/dashboard` loads React app.
- Current dashboard checklist from Phase 0 still works.
- Existing tests pass.
- Old inline dashboard is removed or reduced to a static app loader.

---

## Phase 2 — Minimal Event Bus + Native Browser Voice Mode Together

Phase 2 and Phase 3 should not be separate in the original order. Voice UX needs live status, and live status needs events. Build the minimal event bus first, then voice on top of it.

### Goal

From `/dashboard`, the user can talk to Alfred with a real browser voice UI:

- live waveform from microphone input
- interim transcript
- submit transcript to `/ask`
- receive Alfred response
- play browser-controlled TTS
- waveform reacts to playback
- stop speaking
- interrupt and listen again

### Reference

Study:

```txt
reference-repos/rezaulhreza-jarvis/web/src/hooks/useVoice.ts
reference-repos/rezaulhreza-jarvis/web/src/components/voice/VoiceOverlay.tsx
reference-repos/rezaulhreza-jarvis/web/src/components/voice/WaveformVisualizer.tsx
```

### Build Frontend

```txt
web/src/hooks/useAlfredVoice.ts
web/src/hooks/useAlfredEvents.ts
web/src/components/voice/VoiceOverlay.tsx
web/src/components/voice/WaveformVisualizer.tsx
web/src/pages/VoicePage.tsx
```

### Minimal Backend Event Bus

Add:

```txt
src/alfred-2/events.ts
```

Expose:

```txt
GET /api/events
```

Use Server-Sent Events.

Minimum event shape:

```ts
type AlfredEvent =
  | { type: "ask:start"; requestId: string; text: string }
  | { type: "ask:done"; requestId: string; displayText: string }
  | { type: "ask:error"; requestId: string; message: string }
  | { type: "tool:start"; requestId: string; tool: string }
  | { type: "tool:done"; requestId: string; tool: string; ok: boolean }
  | { type: "confirmation:created"; requestId: string; count: number }
  | { type: "speech:start"; requestId: string; provider: string }
  | { type: "speech:done"; requestId: string; provider: string }
  | { type: "speech:error"; requestId: string; provider: string; message: string };
```

Important: **speech events must carry `requestId`**. Once interruption exists, more than one response can be in flight or recently cancelled.

### Browser STT Decision

Initial implementation may use the browser Web Speech API, but this must be labeled temporary:

> Browser speech recognition is an MVP unblock and may not be local. Alfred remains local-first by design, but native/local STT should replace or supplement browser STT later.

Current Wispr Flow integration remains supported during this phase.

### Backend TTS Refactor

Refactor:

```txt
src/alfred-2/speech.ts
```

Add lower-level synthesis:

```ts
synthesizeSpeech(text, options): Promise<{
  audio: Buffer;
  contentType: "audio/mpeg" | "audio/wav";
  provider: "fish" | "edge" | "macos";
}>
```

Add endpoints:

```txt
GET  /api/voice/settings
POST /api/voice/settings
POST /api/voice/synthesize
POST /api/voice/stop
```

Current server-side `speak()` can still exist. The frontend needs browser-playable audio so it can visualize playback and interrupt it.

### Interruption Design

Do not treat “interrupt works” as a small button.

Define behavior explicitly:

1. Client stops currently playing browser audio immediately.
2. Client marks the interrupted `requestId` as inactive.
3. If the server request is still in flight and cancellation is supported, abort it.
4. If server-side cancellation is not yet supported, discard late results for inactive `requestId`s on the client.
5. Late events must not overwrite the UI state of a newer request.

Initial MVP can discard late client-side results. True server cancellation can follow.

### Done When

From `/dashboard`:

1. click mic
2. speak
3. see transcript live
4. Alfred sends it to `/ask`
5. UI enters thinking/tool/speaking states from events
6. response appears
7. TTS plays in browser
8. waveform reacts to mic input and playback
9. interrupt does not let older responses clobber newer ones

---

## Phase 3 — Finish Live Event Stream Wiring

### Goal

Extend events beyond voice so the app feels live everywhere.

### Wire Events Into

- Radar page activity
- Voice page state
- Safety page pending approvals
- Tools page tool activity
- Work Radar signals later

### Keep `/dashboard/state` As Hydration

SSE reconnect is not reliable state replay. On reconnect:

1. reconnect EventSource
2. refetch `/dashboard/state`
3. reconcile UI

### Done When

During an ask, the UI can show:

```txt
Listening → Thinking → Using tool → Needs approval / Speaking → Done
```

without polling as the only mechanism.

---

## Phase 4 — Memory Taxonomy Before Knowledge/RAG Code

**Status: implemented on 2026-07-14.** The shared contract lives in `src/alfred-2/memory-types.ts`; profile persistence and session working memory map into it without adding Knowledge/RAG storage.

### Implemented Design

- `MemoryRecord` is a discriminated union of `ProfileMemoryRecord`, `SessionMemoryRecord`, and `KnowledgeSourceRecord`, each with a stable `id`, timestamps, and write-time `MemoryProvenance`.
- New profile facts use a deterministic ID derived from key plus creation time. Legacy facts without IDs also include their original array position in the deterministic fingerprint, avoiding collisions between duplicate legacy records while remaining stable across loads. Duplicate persisted canonical IDs are rejected. Merely loading `~/.alfred/profile.json` does not rewrite its content; the next explicit profile write persists additive canonical fields while retaining legacy aliases and unknown extension fields.
- Legacy `source: "user"` maps to `provenance.source: "manual"`; `source: "observed"` maps to `"conversation"`. Missing request/turn identifiers and confidence are not invented.
- The existing `remember` and `recall` tools remain registered. `remember` delegates to the canonical profile-memory write operation and captures tool call, request, and turn provenance. Stable-ID deletion is available through `DELETE /dashboard/facts/:id`; deterministic natural-language deletion by key remains compatible.
- Profile persistence is injectable through a per-instance `ProfileStore`/server `profileFile`; server tests use temporary paths rather than the real user profile. Writes serialize through a cross-instance lock, refresh from disk before mutation, use a same-directory temporary file plus rename, and enforce `0700` directory/`0600` file permissions. Corrupt input, stale direct saves, and persistence failures surface without replacing the existing file or retaining a false-success cache mutation.
- Session records are sanitized, bounded, stable-ID records in the existing process-scoped ring buffer. They remain ephemeral and continue to own recent context, token pressure, and handoff behavior.
- `/dashboard/state` adds grouped `memory.profile`, `memory.session`, and `memory.knowledge` contracts while retaining `profileFacts` and `memoryTurns` compatibility fields. Backend and web import the same shared memory envelope and record types.
- The Memory page is the only Knowledge UI home and uses accessible Profile, Session, and Knowledge tabs. Hydration is latest-request-wins, and successful profile mutations reconcile locally before background refresh.

### Persistence Boundaries and Deferred Work

- Profile memory remains durable in `~/.alfred/profile.json` by default.
- Session taxonomy memory remains process/session scoped and is never persisted by this phase. Alfred's separate activity history remains durable, has private file permissions, and may retain bounded request/response and tool metadata.
- Knowledge defines source metadata only. Phase 5 owns ingestion, chunks, embeddings, indexing, retrieval ranking, citations, and source storage.
- Automatic fact extraction, contradiction resolution, confidence inference, and background memory writes remain deferred; Phase 4 writes are explicit.

### Goal

Define memory concepts before building storage that will constrain them.

Alfred needs three memory categories:

### 1. Profile Facts

Stable user facts.

Example:

```txt
User prefers concise responses.
User calls the assistant Alfred.
```

### 2. Session / Working Memory

Recent useful context from the current task/session.

Example:

```txt
User is redesigning Alfred into a standalone local assistant.
Current preferred vibe is butler/operator, not generic Jarvis neon.
```

### 3. Knowledge / RAG Sources

Documents, notes, project context, reference material.

### Provenance Requirement

If Alfred can show why it remembers something, provenance must be captured at write time.

Memory records should include:

```ts
type MemoryProvenance = {
  source: "manual" | "conversation" | "tool" | "import";
  sourceId?: string;
  requestId?: string;
  turnId?: string;
  timestamp: string;
  confidence?: number;
};
```

### Start With Explicit Memory Writes

Do not start with automatic extraction.

First ship explicit writes:

```txt
remember_fact(text, type)
forget_fact(id)
```

Automatic inference can come later. It requires solving:

- what triggers extraction
- how contradictions resolve
- how confidence is assigned
- how user reviews/approves memory writes

### UI Decision

Do not build both:

```txt
KnowledgePage.tsx
Memory page -> Knowledge tab
```

Pick one home.

Decision for now:

```txt
MemoryPage.tsx
  Profile tab
  Session tab
  Knowledge tab
```

Knowledge can have deep subviews, but it lives under Memory.

### Done When

- Memory taxonomy is documented in code/types.
- Existing profile facts are mapped into the new model.
- No duplicate Knowledge UI surface exists.

---

## Phase 5 — Knowledge/RAG MVP Built Into the Memory Taxonomy

**Status: lexical MVP implemented on 2026-07-14.** Alfred persists private source metadata and deterministic chunks in `~/.alfred/knowledge/`, supports Text/Markdown import, deletion, reindexing, lexical search, the read-only `search_knowledge` tool, the confirmation-gated `import_knowledge` tool for workspace files and clearly labeled assistant-created notes, validated request-scoped citations, and Knowledge-tab source management. Ollama embeddings and `embeddings.jsonl` remain deliberately deferred until lexical retrieval is proven in daily use.

### Goal

Add local document/source retrieval without overbuilding a vector database platform.

### Reference

Study:

```txt
reference-repos/rezaulhreza-jarvis/jarvis/knowledge/rag.py
reference-repos/leon-ai-leon/server/src/core/memory-manager/
reference-repos/leon-ai-leon/core/context/ARCHITECTURE.md
```

### Build Alfred Knowledge Module

```txt
src/alfred-2/knowledge/
  types.ts
  chunker.ts
  embeddings.ts
  store.ts
  search.ts
  ingest.ts
```

### Storage

Use local file-backed storage first:

```txt
~/.alfred/knowledge/
  sources.json
  chunks.jsonl
  embeddings.jsonl
```

### Embeddings Decision

Do not start with generic provider abstraction.

Initial decision:

- Prefer local Ollama embeddings if available.
- If not available, knowledge search can ship with lexical search first.
- Add OpenAI or other embedding provider later only when needed.

Avoid premature:

```txt
ALFRED_EMBEDDING_PROVIDER=openai|ollama
```

until Alfred truly supports and tests both.

### APIs

```txt
GET    /api/memory/knowledge/sources
POST   /api/memory/knowledge/sources
POST   /api/memory/knowledge/search
DELETE /api/memory/knowledge/sources/:id
POST   /api/memory/knowledge/sources/:id/reindex
```

### Tool Loop Integration

Add tool:

```ts
{
  tool: "search_knowledge",
  query: string,
  topK?: number
}
```

Alfred should use this before guessing when the user asks about stored docs/project notes.

### Done When

- User can add a text/markdown source.
- Source is chunked and searchable.
- Alfred can answer with citations.
- User can delete/reindex source.

---

## Phase 6 — Memory Cleanup Beyond Knowledge

### Goal

Finish the three-way memory model.

### Backend

```txt
src/alfred-2/memory/
  profile.ts
  session.ts
  recall.ts
  extraction.ts
  provenance.ts
```

### Frontend

```txt
web/src/pages/MemoryPage.tsx
```

Tabs:

```txt
Profile
Session
Knowledge
```

### Behavior

- Profile facts are editable/deletable.
- Session memory can be inspected and cleared.
- Knowledge sources are searchable and cited.
- Every memory item has provenance.

### Done When

Alfred can show:

- what it remembers
- where it came from
- when it was stored
- how to delete it

---

## Phase 7 — Work Radar, Unified With Notification/Awareness Signals

### Goal

Build a work-awareness surface that is not cmux-specific.

### Important Design Rule

Work Radar must not create a second independent “what needs attention” brain if notification/awareness systems already compute similar signals.

Unify these signal sources:

- interruption engine
- meeting awareness
- stuck-work watcher
- pending notifications
- dirty repos
- open PRs
- CI failures
- cmux active sessions

If a signal already exists elsewhere, Work Radar should consume it or share the same computation module.

### Page

```txt
web/src/pages/WorkPage.tsx
```

### Backend

```txt
src/alfred-2/work/
  index.ts
  signals.ts
  cmux.ts
  git.ts
  github.ts
  ci.ts
  notifications.ts
```

### Radar Cards

- current target
- active cmux workspace
- dirty git repos
- open PRs
- CI failures
- pending notifications
- recently active sessions
- suggested next action

### Naming

UI says:

```txt
Work Radar
```

not:

```txt
cmux Dashboard
```

### Done When

Home/Radar page shows real attention signals:

```txt
3 things need attention
1 pending approval
2 dirty workspaces
1 failing CI
```

and clicking any item opens the relevant detail page.

---

## Phase 8 — Toolkit Registry With Risk Folded In

### Goal

Move from a flat tool list to scalable toolkit groups.

Use Leon as architecture reference, but keep Alfred’s implementation smaller.

### Toolkits

```txt
voice
memory
knowledge
work
files
shell
browser
cmux
github
ci
```

### Backend Shape

```txt
src/alfred-2/toolkits/
  registry.ts
  types.ts
  voice.ts
  memory.ts
  knowledge.ts
  work.ts
  cmux.ts
  files.ts
  shell.ts
```

### Toolkit Entry

Risk/confirmation must be part of this model. Do not keep risk as a separate system that must be manually synchronized.

The previous single `riskLevel` enum (`"read" | "external" | "mutation" | "destructive"`) collapsed two independent axes into one field:

- **Mutation level**: what the tool can do to state (read, mutate, destroy).
- **Network exposure**: whether execution reaches outside this machine.

A `search_knowledge` call (local read) and a `fetch_github_pr_status` call (network read) are both "read" in the mutation sense, but only one can leak a query to a third party. Similarly, a local file write and a Slack post are both "mutation," but the blast radius differs dramatically. A four-value enum forces one of each pair to be mislabeled relative to the other.

Resolution: split into two fields and derive confirmation from the pair.

```ts
type MutationLevel = "read" | "mutation" | "destructive";

type ToolkitTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;

  // What the tool can do to local state.
  mutationLevel: MutationLevel;

  // Whether execution reaches outside this machine at all
  // (network request, third-party API, external service).
  // Does not change confirmation tier on its own, but affects
  // risk display and audit visibility in the UI.
  touchesNetwork: boolean;

  // Derived confirmation posture:
  //
  // "none"     — Execute without asking.
  //              Applies to all reads (local or network).
  //
  // "confirm"  — Single approval gesture. Voice "yes" or one
  //              button click is enough. For local file edits,
  //              local writes, local bash mutations where the
  //              blast radius is this machine only.
  //
  // "explicit" — Requires deliberate, unambiguous action.
  //              Typed confirmation, two-step UI, or a confirmation
  //              code. Voice "yes" alone is not sufficient.
  //              Applies to: destructive operations (always)
  //              AND network-reaching mutations (Slack posts,
  //              GitHub API writes, remote deployments).
  //
  // Derivation:
  //   mutationLevel === "destructive"              → "explicit"
  //   mutationLevel === "mutation" && touchesNetwork → "explicit"
  //   mutationLevel === "mutation" && !touchesNetwork → "confirm"
  //   mutationLevel === "read"                     → "none"
  confirmation: "none" | "confirm" | "explicit";

  enabled: boolean;
  available: boolean;
  missingConfig: string[];
};
```

This means the existing `classifyToolRisk()` in `src/alfred-2/risk.ts` gets a companion: `classifyToolRisk()` stays as the runtime bash-command classifier (regex-based, needed for dynamic bash risk assessment), but the toolkit registry declares each tool's static posture directly. The two systems agree — the registry is the authoritative source, the bash classifier handles the one tool where risk can't be known statically.

#### Examples

| Tool | mutationLevel | touchesNetwork | confirmation | Why |
|------|--------------|---------------|-------------|-----|
| `read_file` | read | false | none | Local read, no risk |
| `web_search` | read | true | none | Read-only, even though query leaves machine |
| `write_file` | mutation | false | confirm | Local file write, single yes |
| `gh pr merge` | mutation | true | explicit | Network mutation, typed confirmation |
| `rm -rf` (via bash) | destructive | false | explicit | Destructive, always explicit |
| `git push --force` | destructive | true | explicit | Destructive + network, doubly explicit |

### Module Relationship

`src/alfred-2/work/` owns work-signal computation.

`src/alfred-2/toolkits/work.ts` wraps that module as Alfred tools.

Do not duplicate logic.

### Frontend

Tools page groups by toolkit instead of dumping schemas.

### Done When

The UI can show:

```txt
Knowledge: 3 tools available
Voice: 4 tools available
Work: 6 tools available
cmux: connected
GitHub: missing token
```

and every displayed tool includes its risk/confirmation posture.

---

## Phase 9 — Visual Identity Finalization

Only after the product structure works.

### Keep

- waveform
- dry British wit
- app pages
- not too large text
- medium density
- tactile local-app feel

### Remove Later

Once a direction is selected, remove the theme sampler and harden one visual identity.

Current likely final direction:

> old-money butler + underground operator console

Not too neon, not too rounded, not generic SaaS.

---

## Revised Implementation Order

1. Inventory current dashboard features, current tools, and risk classifications.
2. React app shell.
3. Minimal event bus + browser voice mode together.
4. Finish live event stream wiring.
5. Memory taxonomy definition before Knowledge storage code.
6. Knowledge/RAG MVP built into that taxonomy.
7. Rest of memory cleanup.
8. Work Radar, explicitly reconciled with notification/awareness signal computation.
9. Toolkit registry, with risk classification folded in.
10. Visual identity finalization.

---

## What Not To Do

Do **not**:

- copy huge chunks from Jarvis repos
- run their install scripts
- make Alfred depend on cmux as the core identity
- build everything into one dashboard page
- build RAG before defining memory taxonomy
- add heavy vector DB infrastructure before a file-backed MVP proves useful
- keep expanding `dashboard.ts` as an HTML string
- create two competing “what needs attention” systems
- create two competing Knowledge UIs
- build generic provider abstraction before Alfred has multiple real providers
- add automatic memory extraction before explicit memory writes and provenance work

---

## First Meaningful Milestone

The first meaningful milestone is:

> `/dashboard` becomes a real app, and the user can talk to Alfred from the browser with live waveform, transcript, status events, response playback, and safe interruption behavior.

That is the foundation. Everything else builds cleanly on top of that.
