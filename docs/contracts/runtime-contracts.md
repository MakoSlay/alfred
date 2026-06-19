# Alfred Runtime Contracts

Status: initial contract draft for Task 001. These contracts intentionally avoid daemon endpoint details. The same shapes should be usable by the future daemon, CLI, web UI, Pi bridge, and tests once the TypeScript project skeleton exists.

## Design principles

- Alfred core is source-agnostic: Pi `/alfred`, CLI, web UI, and future voice/text inputs all call the same handle/confirm/cancel/action contract.
- Alfred targets are cmux-first, not Pi-first. Pi chats and Codex sessions are typed metadata layered on top of cmux surfaces.
- Sending text into a terminal is privileged. All sends require capability checks and, by default, a draft-confirm step.
- Events/history are dashboard-safe by default and carry redaction/retention metadata for any sensitive text.
- Failed privileged actions must report failure and must not be recorded as successful sends.

## Primitive aliases

```ts
export type AlfredId = string;
export type IsoTimestamp = string;
export type AlfredRef = string;

export type AlfredSourceKind = "pi-command" | "cli" | "web-ui" | "voice" | "text" | "system";
export type AlfredTargetKind = "cmux-workspace" | "cmux-surface" | "pi-chat" | "codex-session" | "terminal" | "unknown";
export type AlfredActionKind = "draft" | "confirm" | "cancel" | "send" | "loop.start" | "loop.stop" | "loop.status" | "status";
export type AlfredCapability =
  | "world.read"
  | "surface.read"
  | "surface.send"
  | "workspace.send"
  | "loop.manage"
  | "history.read"
  | "history.write"
  | "config.read";
```

## Source/interface contract

```ts
export interface AlfredSource {
  kind: AlfredSourceKind;
  id: AlfredId;
  label?: string;
  sessionId?: string;
  userIntent?: "spoken" | "typed" | "button" | "automation";
  trustedLocalOnly: boolean;
  capabilities: AlfredCapability[];
  presentation?: {
    wantsSpeech?: boolean;
    wantsText?: boolean;
    style?: "butler" | "plain" | "compact";
  };
}
```

Required source examples:

- Pi `/alfred`: `{ kind: "pi-command", trustedLocalOnly: true, wantsSpeech: true }`.
- CLI: `{ kind: "cli", trustedLocalOnly: true, wantsText: true }`.
- Web UI: `{ kind: "web-ui", trustedLocalOnly: false, wantsText: true }`; must be protected by local auth/origin/host checks before privileged capabilities are granted.
- Future voice/text: `{ kind: "voice" }` or `{ kind: "text" }`; voice transcription is input metadata, not a privileged target.

## Target model

```ts
export interface AlfredTarget {
  kind: AlfredTargetKind;
  ref: AlfredRef;
  label: string;
  workspaceRef?: AlfredRef;
  workspaceLabel?: string;
  surfaceRef?: AlfredRef;
  processKind?: "pi" | "codex" | "shell" | "node" | "python" | "unknown";
  current?: boolean;
  selected?: boolean;
  confidence?: "exact" | "prefix" | "substring" | "fuzzy" | "inferred" | "unknown";
  capabilities: AlfredCapability[];
  metadata?: Record<string, string | number | boolean | null>;
}
```

Target interpretations:

- `cmux-workspace`: a cmux workspace ref such as `workspace:9`; can receive workspace-level send only when `workspace.send` is granted.
- `cmux-surface`: a terminal surface ref such as `surface:10`; can be read/sent when `surface.read`/`surface.send` are granted.
- `pi-chat`: a cmux surface known or inferred to contain Pi; represented as `kind: "pi-chat"` plus `surfaceRef` and optional Pi session metadata.
- `codex-session`: a cmux surface known or inferred to contain Codex; represented as `kind: "codex-session"` plus `surfaceRef` and optional session metadata.
- `terminal`: a surface with no stronger process classification.
- `unknown`: a candidate target Alfred can display but must not send to without clarification and capability confirmation.

## Request and response

```ts
export interface AlfredHandleRequest {
  requestId: AlfredId;
  createdAt: IsoTimestamp;
  source: AlfredSource;
  input: {
    text: string;
    locale?: string;
    transcriptionConfidence?: number;
  };
  context?: {
    currentWorkspaceRef?: AlfredRef;
    currentSurfaceRef?: AlfredRef;
    visibleTargets?: AlfredTarget[];
    activeDraftId?: AlfredId;
    activeLoopId?: AlfredId;
  };
  policy?: {
    dryRun?: boolean;
    requireConfirmationForSend?: boolean;
    maxTranscriptChars?: number;
    allowedCapabilities?: AlfredCapability[];
  };
}

export interface AlfredHandleResponse {
  requestId: AlfredId;
  createdAt: IsoTimestamp;
  ok: boolean;
  speech?: string;
  displayText: string;
  proposedActions: AlfredAction[];
  pendingDraft?: AlfredDraft;
  activeLoop?: AlfredLoopSummary;
  events: AlfredEvent[];
  errors?: AlfredError[];
  fallback?: AlfredFallback;
  nextStatePatch?: AlfredStatePatch;
}
```

Response rules:

- `displayText` is safe to show in CLI/web/Pi UI.
- `speech` is optional presentation text and must not contain raw JSON action proposals or secrets.
- `proposedActions` may contain immediate low-risk actions (`status`, `loop.status`) or pending privileged actions (`draft`, `send`).
- When a send requires confirmation, response returns `pendingDraft` and a `draft.created` event rather than a `send` success.
- `fallback` explains whether the caller should use local Pi behavior, ask for clarification, or retry later.

## Actions

```ts
export type AlfredAction =
  | AlfredDraftAction
  | AlfredConfirmAction
  | AlfredCancelAction
  | AlfredSendAction
  | AlfredLoopStartAction
  | AlfredLoopStopAction
  | AlfredLoopStatusAction
  | AlfredStatusAction;

export interface AlfredBaseAction {
  id: AlfredId;
  kind: AlfredActionKind;
  createdAt: IsoTimestamp;
  requestedBy: AlfredSource;
  target?: AlfredTarget;
  requiredCapabilities: AlfredCapability[];
  status: "proposed" | "pending_confirmation" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  reason?: string;
}

export interface AlfredDraftAction extends AlfredBaseAction {
  kind: "draft";
  target: AlfredTarget;
  draftText: RedactedText;
  confirmBeforeSend: true;
  expiresAt: IsoTimestamp;
}

export interface AlfredConfirmAction extends AlfredBaseAction {
  kind: "confirm";
  draftId: AlfredId;
}

export interface AlfredCancelAction extends AlfredBaseAction {
  kind: "cancel";
  draftId?: AlfredId;
  loopId?: AlfredId;
}

export interface AlfredSendAction extends AlfredBaseAction {
  kind: "send";
  target: AlfredTarget;
  text: RedactedText;
  confirmationId?: AlfredId;
  transport: "cmux-send-workspace" | "cmux-send-surface";
}

export interface AlfredLoopStartAction extends AlfredBaseAction {
  kind: "loop.start";
  target: AlfredTarget;
  goal: RedactedText;
  maxTurns: number;
  silent: boolean;
}

export interface AlfredLoopStopAction extends AlfredBaseAction {
  kind: "loop.stop";
  loopId: AlfredId;
  interruptTarget?: boolean;
}

export interface AlfredLoopStatusAction extends AlfredBaseAction {
  kind: "loop.status";
  loopId?: AlfredId;
}

export interface AlfredStatusAction extends AlfredBaseAction {
  kind: "status";
  scope: "world" | "target" | "history" | "capabilities";
}
```

Action semantics:

- `draft`: creates pending text for a target; never sends.
- `confirm`: authorizes a pending draft or pending loop start by id.
- `cancel`: cancels a pending draft or loop.
- `send`: executes through cmux only after capability checks and required confirmation.
- `loop.start`: starts a managed target loop; the loop may send follow-up messages only within its granted capability envelope.
- `loop.stop`: stops a managed loop and may interrupt the target if explicitly requested.
- `loop.status`: returns current loop state without sending to the target.
- `status`: read-only world/history/capability inspection.

## Drafts, loops, and state patches

```ts
export interface AlfredDraft {
  id: AlfredId;
  target: AlfredTarget;
  text: RedactedText;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  status: "pending" | "confirmed" | "sent" | "cancelled" | "expired" | "failed";
  createdBy: AlfredSource;
}

export interface AlfredLoopSummary {
  id: AlfredId;
  target: AlfredTarget;
  goal: RedactedText;
  status: "running" | "waiting" | "needs_user" | "done" | "stopped" | "failed";
  turns: number;
  maxTurns: number;
  startedAt: IsoTimestamp;
  lastActivityAt?: IsoTimestamp;
  observeMode?: "screen" | "session-current" | "session-file" | "adapter";
}

export interface AlfredStatePatch {
  rememberTarget?: AlfredTarget;
  rememberDraftId?: AlfredId | null;
  rememberLastSpeech?: RedactedText;
  rememberLastSentText?: RedactedText;
  activeLoopId?: AlfredId | null;
}
```

## Events and history

```ts
export type AlfredEventKind =
  | "request.received"
  | "world.observed"
  | "draft.created"
  | "draft.confirmed"
  | "draft.cancelled"
  | "send.started"
  | "send.succeeded"
  | "send.failed"
  | "loop.started"
  | "loop.waiting"
  | "loop.replied"
  | "loop.needs_user"
  | "loop.done"
  | "loop.stopped"
  | "error.raised"
  | "fallback.used";

export interface AlfredEvent {
  id: AlfredId;
  kind: AlfredEventKind;
  createdAt: IsoTimestamp;
  requestId?: AlfredId;
  source?: Pick<AlfredSource, "kind" | "id" | "label">;
  target?: AlfredTarget;
  actionId?: AlfredId;
  loopId?: AlfredId;
  summary: string;
  data?: Record<string, unknown>;
  redaction: RedactionMetadata;
  retention: RetentionMetadata;
}
```

Dashboard/history rules:

- Dashboard reads events, drafts, loop summaries, and safe target summaries; it should not need raw transcripts.
- Raw transcript snippets, prompt text, LLM raw output, and sent text must be redacted or explicitly marked as sensitive.
- History should support debugging failed sends without retaining indefinite raw terminal dumps.

## Redaction and retention

```ts
export interface RedactedText {
  value: string;
  redaction: RedactionMetadata;
}

export interface RedactionMetadata {
  status: "not_needed" | "redacted" | "contains_sensitive" | "unknown";
  rulesApplied?: string[];
  originalLength?: number;
}

export interface RetentionMetadata {
  policy: "ephemeral" | "session" | "short" | "manual";
  expiresAt?: IsoTimestamp;
  reason?: string;
}
```

Initial retention policy:

- Pending draft text: `session` retention, expires with draft unless sent/cancelled event summary needs a redacted record.
- Sent text history: `short` retention in redacted/summarized form; raw text should be avoided unless explicitly needed for local debugging.
- Transcript snippets: `ephemeral` by default and capped by `maxTranscriptChars`.
- LLM prompts/raw responses: not dashboard-visible by default; persist only if local debug mode is explicitly enabled.
- Secrets/API keys: never stored in history and never committed.

## Errors, fallback, and capabilities

```ts
export interface AlfredError {
  code:
    | "invalid_request"
    | "target_not_found"
    | "target_ambiguous"
    | "capability_denied"
    | "confirmation_required"
    | "confirmation_expired"
    | "send_failed"
    | "loop_already_running"
    | "loop_not_found"
    | "cmux_unavailable"
    | "llm_unavailable"
    | "internal_error";
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export interface AlfredFallback {
  kind: "none" | "local-pi" | "ask-clarification" | "retry-later" | "manual";
  reason: string;
}
```

Capability rules:

- Sources receive capabilities from local policy, not from self-declared request fields alone.
- Browser-originated sources start with read-only capabilities until host/origin/auth/CSRF checks pass.
- `surface.send`, `workspace.send`, and `loop.manage` are privileged.
- `send` and `loop.start` require target capability plus source capability.
- Missing daemon, missing cmux, denied capability, or expired confirmation must fail closed.
- Pi bridge fallback is `local-pi` only when the Pi extension has explicitly enabled bridge mode and the daemon is absent/unusable before any daemon-side action was accepted.

## Example: Powerco / Power Code draft-confirm flow

### 1. Pi `/alfred` asks Alfred to draft to a named chat

```json
{
  "requestId": "req_powerco_001",
  "createdAt": "2026-06-19T21:00:00.000Z",
  "source": {
    "kind": "pi-command",
    "id": "pi-main-session",
    "label": "/alfred",
    "userIntent": "typed",
    "trustedLocalOnly": true,
    "capabilities": ["world.read", "surface.read", "surface.send", "loop.manage"],
    "presentation": { "wantsSpeech": true, "wantsText": true, "style": "butler" }
  },
  "input": {
    "text": "those are good suggestions. use my power co session in this workspace and try to implement ways to fix it"
  },
  "context": {
    "currentWorkspaceRef": "workspace:9",
    "currentSurfaceRef": "surface:20",
    "visibleTargets": [
      {
        "kind": "pi-chat",
        "ref": "surface:42",
        "label": "π - Power Code",
        "workspaceRef": "workspace:9",
        "workspaceLabel": "Powerco",
        "surfaceRef": "surface:42",
        "processKind": "pi",
        "confidence": "fuzzy",
        "capabilities": ["surface.read", "surface.send"]
      }
    ]
  },
  "policy": { "requireConfirmationForSend": true, "maxTranscriptChars": 12000 }
}
```

### 2. Alfred responds with a pending draft, not a send

```json
{
  "requestId": "req_powerco_001",
  "createdAt": "2026-06-19T21:00:00.200Z",
  "ok": true,
  "speech": "Shall I send that to π - Power Code, sir?",
  "displayText": "Draft ready for π - Power Code. Confirm before sending.",
  "proposedActions": [
    {
      "id": "act_draft_001",
      "kind": "draft",
      "createdAt": "2026-06-19T21:00:00.200Z",
      "requestedBy": { "kind": "pi-command", "id": "pi-main-session", "trustedLocalOnly": true, "capabilities": ["world.read", "surface.read", "surface.send", "loop.manage"] },
      "target": { "kind": "pi-chat", "ref": "surface:42", "label": "π - Power Code", "workspaceRef": "workspace:9", "surfaceRef": "surface:42", "capabilities": ["surface.read", "surface.send"] },
      "requiredCapabilities": ["surface.send"],
      "status": "pending_confirmation",
      "draftText": { "value": "Try implementing ways to fix it.", "redaction": { "status": "not_needed" } },
      "confirmBeforeSend": true,
      "expiresAt": "2026-06-19T21:05:00.200Z"
    }
  ],
  "pendingDraft": {
    "id": "draft_powerco_001",
    "target": { "kind": "pi-chat", "ref": "surface:42", "label": "π - Power Code", "workspaceRef": "workspace:9", "surfaceRef": "surface:42", "capabilities": ["surface.read", "surface.send"] },
    "text": { "value": "Try implementing ways to fix it.", "redaction": { "status": "not_needed" } },
    "createdAt": "2026-06-19T21:00:00.200Z",
    "expiresAt": "2026-06-19T21:05:00.200Z",
    "status": "pending",
    "createdBy": { "kind": "pi-command", "id": "pi-main-session", "trustedLocalOnly": true, "capabilities": ["world.read", "surface.read", "surface.send", "loop.manage"] }
  },
  "events": [
    {
      "id": "evt_draft_001",
      "kind": "draft.created",
      "createdAt": "2026-06-19T21:00:00.200Z",
      "requestId": "req_powerco_001",
      "actionId": "act_draft_001",
      "summary": "Created draft for π - Power Code.",
      "redaction": { "status": "not_needed" },
      "retention": { "policy": "session", "expiresAt": "2026-06-19T21:05:00.200Z" }
    }
  ]
}
```

### 3. Confirming sends through cmux and records success/failure honestly

A later `confirm` action references `draft_powerco_001`. If `cmux send --surface surface:42 ...` and enter succeed, Alfred records `send.succeeded`. If cmux fails, Alfred records `send.failed`, keeps/marks the draft as failed, and returns `ok: false` with `code: "send_failed"`.

## Example: non-Pi CLI read-only status

```json
{
  "requestId": "req_cli_001",
  "createdAt": "2026-06-19T21:10:00.000Z",
  "source": {
    "kind": "cli",
    "id": "alfred-cli",
    "trustedLocalOnly": true,
    "capabilities": ["world.read", "history.read"],
    "presentation": { "wantsText": true, "style": "plain" }
  },
  "input": { "text": "loop status" },
  "policy": { "requireConfirmationForSend": true }
}
```

Expected response is a `loop.status` or `status` action only. It must not require Pi speech/TTS and must not assume a Pi chat exists.

## Implementation notes for Task 002

When the TypeScript skeleton is created, move these shapes into exported TypeScript modules under `src/contracts/`, add fixture builders under `src/testing/`, and add tests that construct representative Pi, CLI, and web JSON fixtures using the exported types/helpers.
