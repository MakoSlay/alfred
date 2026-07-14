# Alfred Self-Renewing Capabilities Roadmap

> **Status:** architecture proposal only — no implementation authorized by this document
>
> **Date:** 2026-07-10
>
> **Product posture:** local-first, one user/machine, human-gated adoption

## 1. Executive recommendation

### Recommendation

Build **only the structured-outcome prerequisite in the near term**, after the standalone React/event/voice milestone. Treat the durable observation journal as separately budgeted, non-critical work after the memory taxonomy is stable. Do not build autonomous code generation now.

The smallest valuable slice is a **deterministic failure-observation journal**, not yet a generator:

1. Alfred records structured, redacted evidence when a task ends without completion.
2. Deterministic rules classify categories that current evidence can prove.
3. With the current flat registry, automatic `missing_capability` eligibility remains disabled; the user may mark a tentative gap for later review.
4. The user can inspect, correct, suppress, or mark an observation as worth revisiting after semantic toolkit descriptors exist.
5. No proposal code, generation job, or background scheduler exists in this first slice.

This slice is useful even if generation is never shipped. It will show whether Alfred actually has recurring capability gaps or mostly has planning, configuration, reliability, and existing-tool problems. That evidence should decide whether later investment is justified.

### Challenge to the premise

“Self-renewing” is a dangerous product metaphor if it implies self-modifying software. Alfred cannot infer from a failed request that:

- a new tool is the right remedy;
- the failure was caused by missing capability;
- generated tests represent the user's intended behavior;
- typecheck success means the tool is safe;
- a sandboxed result will behave correctly against live data; or
- the capability is worth the long-term maintenance cost.

The safe initial product is a **renewal advisor**, not a self-modifying agent. It may observe, aggregate, propose, and explain. It must not install, register, enable, import, or execute a proposal in the live runtime.

### Staged recommendation

| Stage | Scope | Recommendation |
|---|---|---|
| 1 | Failure observation and classification journal | Build only after the standalone event/voice foundation is stable and only as a separately budgeted, non-critical track. With the current flat registry, missing-capability eligibility remains disabled; explicit user input creates only an ineligible `user_reported_gap` for later semantic review. |
| 2 | Explicit user-triggered proposal generation | Build only after classification precision is demonstrated and semantic capability descriptors exist. Declarative, read-only adapters only. |
| 3 | Validation and bounded repair | Build with deterministic gates and inert proposal revisions. No arbitrary TypeScript execution in the MVP. |
| 4 | User review and adoption decision | Add to the standalone dashboard. Acceptance records intent; it does not install anything. |
| 5 | Optional background generation | Wait until the earlier stages have measurable precision, useful proposals, and zero safety-boundary escapes. Opt-in only. |

### MVP success criteria

The observation MVP is successful when:

- every recorded observation has `requestId`, timestamp, source task, observed failure, and relevant structured tool results;
- `turnId` is retained when available and explicitly absent otherwise;
- intermediate failures followed by task success do not become gaps;
- missing credentials, policy blocks, parser hallucinations, ambiguity, timeouts, and transient failures are never promoted as missing tools;
- retries within one request are grouped as one request outcome;
- corrections and basic store-only suppressions survive restart;
- while the registry is flat/name-only, automatic `missing_capability` eligibility is disabled; explicit user input can create only an ineligible `user_reported_gap` for later semantic review;
- a manual audit of at least 30 recorded noncompletion outcomes reaches at least 90% category accuracy, with **zero** configuration, policy, ambiguity, timeout, transient, or parser outcomes mislabeled `missing_capability`;
- the existing `pnpm run check` remains green.

At planning time, `pnpm run check` passes. Each implementation phase must record the baseline commit and observed test count at phase start, then keep the complete current suite green rather than pinning this roadmap to a stale count.

### Non-negotiable architecture invariants

1. Generated artifacts are inert data until copied into a normal reviewed code change outside this system.
2. The live tool registry never scans or imports the proposals directory.
3. The capability subsystem has no repository/registry write handle or adoption executor, and no API transition can mutate the live runtime, source tree, worktree, registry, or enabled-tool set. APIs named `install`, `enable`, `execute`, or `register` are additionally prohibited as defense in depth.
4. Acceptance is not installation.
5. LLM output is untrusted input to deterministic validators.
6. A model-authored test is not independent evidence.
7. A proposal's declared risk is never authoritative; Alfred derives effective risk.
8. Background jobs never inherit `autoConfirm`.
9. Proposal generation and validation receive no ambient secrets or unrestricted host access.
10. If a required isolation control cannot be enforced, validation fails closed.

### Decision ownership: deterministic, LLM, and human

| Owner | Responsibilities |
|---|---|
| Deterministic Alfred code | Outcome capture, error normalization, exclusion precedence, confidence ceilings, lineage/evidence hashes, recurrence and suppression rules, state transitions, context selection/redaction, file/path limits, risk derivation, validation gates, quotas, and notification wording. |
| LLM | Produce an inert proposal within the supplied schema; optionally add a non-promoting classification annotation; create bounded repair revisions from sanitized findings. |
| User | Correct or confirm a tentative gap, request generation, consent to remote-provider context egress, approve origins/permissions, accept/reject/defer, and initiate any later normal development/adoption work. |
| Independent developer/reviewer | Decide how an accepted proposal becomes maintainable repository code and validate the actual integration. |

An LLM never promotes its own annotation, selects its own permissions, declares validation success, changes lifecycle state directly, or decides adoption.

---

## 2. Non-goals

This project is not intended to become:

- a generic plugin system or marketplace;
- a public package registry or sharing network;
- an autonomous source-code maintainer;
- an auto-installer, auto-updater, or runtime hot-loader;
- a general-purpose sandbox for hostile Node programs;
- a second tool registry beside the planned toolkit registry;
- a second notification/attention brain beside the proactive/Work Radar system;
- a cmux-specific feature;
- a reason to postpone the React app, event bus, browser voice, or interruption work;
- a way to evade the existing confirmation model;
- a way to turn every user disappointment into code;
- a way to repair existing tools by generating duplicate replacement tools;
- a substitute for configuration setup, credential management, retry handling, or bug fixing;
- a guarantee that generated behavior is correct, secure, useful, or maintainable;
- a system that reads the full repository, full home directory, private memory, email, documents, terminal scrollback, or environment by default;
- a system that runs package installation or package lifecycle scripts from proposals;
- a system that allows generated bash strings or wrappers.

Arbitrary TypeScript tools are explicitly outside the recommended MVP. They may remain permanently out of scope if declarative adapters prove sufficient.

---

## 3. Current-code inventory and integration points

### 3.1 Runtime composition

`src/alfred-2/server.ts` is currently the composition root. It owns HTTP routing, session memory, pending confirmations, activity sampling, watchers, intervals, history persistence, dashboard hydration, and shutdown cleanup (`server.ts:323-1076`).

Useful patterns:

- request IDs are accepted or generated at the `/ask` boundary (`server.ts:659`);
- request/session IDs flow into `runToolLoop()` (`server.ts:931-941`);
- intervals use overlap guards, `.unref()`, and explicit shutdown cleanup;
- `/dashboard/state` provides hydration and `/tools` provides the current contracts.

Constraint:

- capability jobs must not add more ad hoc timers and state directly to `server.ts`;
- HTTP handlers should be split into a capability API module when implemented;
- a durable job runner is not needed for Stage 1 and should not be built prematurely.

### 3.2 Tool loop

`src/alfred-2/tool-loop.ts` already provides:

- maximum tool rounds, request wall time, bash timeout, and output limits;
- bounded parser repair;
- request/session/tool-call correlation;
- workspace resolution and ambiguity handling;
- no implicit fallback to Alfred's repository when no safe workspace exists;
- structured tool results;
- pending confirmation pause/resume;
- context handoff;
- one deterministic completion invariant for macOS `open` requests.

Primary integration points for Stage 1:

- the `/ask` request boundary in `server.ts`, including validation and deterministic routes that return before `runToolLoop()`;
- parser terminal paths around `tool-loop.ts:302-324`;
- policy, workspace, and execution paths around `tool-loop.ts:344-464`;
- tool-result recording around `tool-loop.ts:467-474`;
- terminal result construction around `tool-loop.ts:533-560`;
- request timeout, maximum rounds, and context handoff paths.

Use one request-boundary outcome finalizer so every accepted `/ask` request produces exactly one terminal `TaskOutcome`, whether it exits before, during, or after `runToolLoop()`. Do not make the observer infer outcomes only from `speech` or `displayText`. Add structured terminal outcomes and structured failure codes first.

### 3.3 Tool contracts and multiple sources of truth

The current runtime has **19** tools. `docs/plans/alfred-dashboard-current-inventory.md` says 18 because `wellness_status` was added later. Current tests expect 19.

Tool metadata is duplicated across:

- names and prompt snippets in `src/alfred-2/tool-types.ts`;
- call interfaces and the `AlfredToolCall` union in the same file;
- dashboard schemas in `src/alfred-2/server.ts`;
- risk classification in `src/alfred-2/risk.ts`;
- execution dispatch in `src/alfred-2/tool-loop.ts`;
- safety metadata returned by individual implementations under `src/alfred-2/tools/`.

The proposal system must not create another live catalog. It should read a read-only snapshot of current capability metadata. When standalone roadmap Phase 8 introduces the toolkit registry, that registry should become the authoritative source for names, schemas, availability, missing configuration, risk, prompt projection, and executors.

### 3.4 Existing result contract

`ToolResult` already contains:

- `toolCallId` and tool name;
- `success` and optional `retryable`;
- text/data/display text;
- truncation and timing;
- safety metadata;
- cwd/workspace metadata.

It does not contain a typed error code, failure stage, HTTP status, timeout cause, configuration prerequisite, or invariant result. Text parsing alone is not a sufficient classification foundation.

Also, every nonzero bash result is currently marked retryable. Stage 1 must normalize causes rather than treating `retryable` as a root-cause label.

### 3.5 Parser behavior

`src/alfred-2/parser.ts` is a useful fail-closed precedent:

- strict JSON object parsing;
- bounded response size;
- unknown fields rejected;
- unknown tools rejected;
- one parser repair attempt;
- terminal graceful failure after repeated invalid output.

An unknown tool emitted by the model is evidence of `invalid_llm_plan`, not evidence of a missing capability. It may be retained as an advisory capability hint, but it is never promotion-eligible by itself.

### 3.6 Risk and confirmation

Current runtime risk is:

```ts
type ToolRiskLevel = "read" | "external" | "mutation" | "destructive";
```

The standalone roadmap correctly plans to split this into:

```ts
type MutationLevel = "read" | "mutation" | "destructive";
type Confirmation = "none" | "confirm" | "explicit";
```

plus `touchesNetwork: boolean`.

Relevant current behavior:

- `src/alfred-2/risk.ts` combines static tool posture and dynamic regex-based bash classification;
- blocked paths, destructive patterns, mutations, and selected diagnostics are recognized;
- unrecognized bash defaults to read/no-confirmation;
- `PendingConfirmationStore` hashes payloads, stores exact previews, expires entries, and exposes integrity verification.

Safety debt relevant to any later adoption flow:

1. The normal confirmation execution path retrieves, removes, and executes the payload without calling `verifyIntegrity()`.
2. `confirm` and `explicit` currently use the same effective approval path.
3. The tool-loop confirmation gate is hardcoded to `bash`, `write_file`, and `edit_file`.
4. Tool implementations can return safety metadata that disagrees with the loop's pre-execution classification.
5. Unknown bash commands fail open as read. This classifier is not a sandbox.

These are not reasons to block Stage 1 observation logging. They are prerequisites before any adopted generated capability can execute through the future toolkit registry.

### 3.7 Existing tools

- File tools provide lexical workspace containment, sensitive-path checks, size/binary limits, exact-edit rules, and undo backups.
- Web tools provide Exa and HTTP fallback, timeouts, and truncation.
- Google tools use read-only OAuth scopes and expose obvious missing-configuration text.
- Session tools are cmux adapters with typed ambiguity and retryable outcomes.
- Profile, context, settings, and wellness tools use local persistence and structured results.

Important limitations for generated proposals:

- current file containment is lexical and is not sufficient against symlink/hardlink escapes;
- current `fetch_content` does not enforce an SSRF-safe destination policy;
- current bash execution uses unrestricted `bash -c` with the daemon user's permissions and environment;
- none of these current execution paths should be reused as a generated-code sandbox.

### 3.8 Proactive system

`src/alfred-2/proactive/` provides reusable presentation policy:

- priorities and delivery channels;
- mute and meeting-aware decisions;
- dedupe keys and cooldowns;
- capped event storage;
- privacy-aware message redaction;
- source references and suggested actions.

It is not a durable gap or job store:

- the store is in memory;
- dedupe replaces the prior occurrence, which destroys recurrence history;
- cooldown state represents delivery, not job scheduling or generation backoff.

Use it later only to present `ready_for_review` events. Keep durable gaps, proposal jobs, attempts, and suppressions in a separate capability store. Work Radar and capability notifications must consume the same proactive event stream rather than compute attention independently.

### 3.9 Tests to preserve and extend

Relevant existing coverage includes:

- `test/alfred2-tool-loop.test.ts`;
- `test/alfred2-tool-types.test.ts`;
- `test/alfred2-risk-confirmation.test.ts`;
- `test/alfred2-proactive-policy.test.ts`;
- `test/alfred2-server-request-id.test.ts`;
- `test/alfred2-file-tools.test.ts`;
- `test/alfred2-web-tools.test.ts`;
- `test/alfred2-google-tools.test.ts`;
- `test/alfred2-integration.test.ts`.

The existing flat registry tests are parity protection, not a final registry design.

---

## 4. Failure/gap taxonomy with deterministic classification rules

### 4.1 Vocabulary

Use different records for different concepts:

- **Attempt:** one tool or parser attempt inside a request.
- **Task outcome:** Alfred's structured end state for one request.
- **Failure observation:** immutable evidence that a request did not complete, or completed only partially.
- **Capability gap:** an aggregate of eligible observations indicating a required operation has no supported capability.
- **Reliability issue:** recurrence involving an existing capability, provider, runtime, or policy; it does not generate a new-tool proposal.
- **Proposal:** an inert, versioned artifact intended to address one capability gap.

Intermediate failures are useful provenance but are not gap observations if the request ultimately succeeds.

### 4.2 Required structured stages and codes

```ts
type FailureStage =
  | "control"
  | "route"
  | "plan"
  | "parse"
  | "authorize"
  | "resolve"
  | "execute"
  | "verify"
  | "deliver"
  | "budget";

type FailureCode =
  | "control.user_cancelled"
  | "contract.invalid_input"
  | "plan.no_matching_capability"
  | "plan.existing_tool_not_selected"
  | "parser.invalid_output"
  | "parser.unknown_tool"
  | "parser.invalid_tool_arguments"
  | "precondition.missing_config"
  | "precondition.missing_credentials"
  | "precondition.dependency_unavailable"
  | "precondition.platform_unavailable"
  | "resolution.ambiguous_request"
  | "resolution.ambiguous_target"
  | "resolution.target_not_found"
  | "policy.blocked"
  | "confirmation.required"
  | "confirmation.denied"
  | "confirmation.expired"
  | "execution.timeout"
  | "execution.rate_limited"
  | "execution.provider_5xx"
  | "execution.network_transient"
  | "execution.invalid_arguments"
  | "execution.exit_nonzero"
  | "execution.internal_error"
  | "verification.invariant_failed"
  | "budget.max_rounds"
  | "budget.request_timeout"
  | "budget.context_handoff"
  | "capability.explicitly_unsupported"
  | "capability.impossible_on_platform"
  | "outcome.unclassified";
```

Tool implementations should eventually return typed error details. Until then, only versioned exact detectors over bounded redacted text may normalize known errors, and those receive lower confidence.

### 4.3 Primary classification categories

```ts
type GapClassification =
  | "missing_capability"
  | "user_reported_gap"
  | "existing_tool_misuse"
  | "invalid_llm_plan"
  | "missing_configuration"
  | "transient_external_failure"
  | "timeout_or_rate_limit"
  | "ambiguous_user_request"
  | "policy_blocked"
  | "unsupported_or_impossible"
  | "existing_tool_bug"
  | "unclassified";
```

### 4.4 Deterministic classification table

| Classification | Required evidence | Exclusions | Proposal eligible? |
|---|---|---|---:|
| `missing_capability` | A structured required operation is known; the registry capability matcher returns `no_match` for enabled and configurable tools; the request is feasible and policy-allowed; the terminal reason is `plan.no_matching_capability` or `capability.explicitly_unsupported`. | Unknown/flat registry result; user assertion alone; unknown model tool; missing config; existing tool match; ambiguity; provider failure; unsupported platform. | Yes, after confidence/recurrence gates. |
| `user_reported_gap` | The user explicitly records that a capability is wanted, but deterministic semantic registry absence has not yet been established. | Must not overwrite deterministic classification or bypass exclusions. | No; re-evaluate in SR-1.5. |
| `existing_tool_misuse` | A known tool exists, but the model selected the wrong tool, supplied schema-invalid arguments, chose the wrong target/cwd, or failed a documented precondition that was available in context. | Internal exception or reproduced invariant failure. | No. Route to prompt/planner quality. |
| `invalid_llm_plan` | Parser-invalid output, hallucinated/unknown tool, unsupported fields, competing JSON objects, or plan claims contradicted by structured execution. | A separately established registry coverage gap. | No. Route to model/parser reliability. |
| `missing_configuration` | Typed missing key, credential, OAuth authorization, dependency, executable, or feature configuration. Record key names/presence only, never values. | 401/403 with valid configuration but policy/account denial should remain unclassified or provider-specific until normalized. | No. Surface setup guidance. |
| `transient_external_failure` | Typed 5xx, connection reset, temporary DNS/provider outage, service unavailable, or known transient provider code. Prefer evidence of prior success or provider status. | 429 and timeouts; stable 4xx; missing credentials. | No new tool. Reliability/backoff only. |
| `timeout_or_rate_limit` | Typed timeout, deadline, HTTP 429, provider quota/rate-limit code, or request budget expiry. | Context handoff and user cancellation are separate control outcomes. | No new tool. Budget/backoff only. |
| `ambiguous_user_request` | Deterministic ambiguity from target resolution or a structured `needs_user_input` outcome with competing candidates. | Model simply says it is confused without candidates or structured reason; that remains unclassified. | No. Ask the user. |
| `policy_blocked` | Risk/path/network policy rejects the action, confirmation is denied/expired, or required permission is not granted. | A capability may not be generated to bypass policy. | Never. |
| `unsupported_or_impossible` | An authoritative platform/registry check says the operation is unsupported, physically unavailable, or impossible under Alfred's product boundaries. | LLM assertion alone. If a safe adapter could support it, classify as `missing_capability`. | No by default; user may manually convert an unsupported product boundary into an approved gap. |
| `existing_tool_bug` | A known valid tool was invoked with valid arguments and available config; transient, timeout, policy, and target causes are excluded; a trusted invariant fails or the failure reproduces against a deterministic fixture/canonical probe. | One opaque exception or nonzero bash exit is not enough. | No new tool. Create a bug/repair item linked to the tool. |
| `unclassified` | Evidence is incomplete, conflicting, text-only, or cannot establish causality. | None. This is the safe default. | Never automatically. |

### 4.5 Classification precedence

Apply deterministic precedence in this order:

1. completed request → no gap observation;
2. privacy/storage prohibition → minimal metadata only, never eligible;
3. policy/confirmation outcome → `policy_blocked`;
4. ambiguity → `ambiguous_user_request`;
5. missing configuration/credentials/dependency → `missing_configuration`;
6. timeout/429/budget timeout → `timeout_or_rate_limit`;
7. typed transient provider/network outcome → `transient_external_failure`;
8. parser/schema/unknown-tool outcome → `invalid_llm_plan` or `existing_tool_misuse`;
9. trusted invariant or reproduced valid-tool failure → `existing_tool_bug`;
10. authoritative unsupported/impossible boundary → `unsupported_or_impossible`;
11. no registry capability for a structured feasible operation → `missing_capability`;
12. otherwise → `unclassified`.

A later rule must never override an earlier exclusion. An LLM annotation can suggest a review label but cannot alter this result or eligibility.

Normative terminal mapping:

| Code/outcome | `TaskOutcome.status` | Classification/disposition |
|---|---|---|
| `control.user_cancelled` | `cancelled` | Normal control; store minimal outcome, no gap. |
| `confirmation.required` | `needs_user_input` | Normal pending control; do not emit a gap unless it later expires/denies. |
| `confirmation.denied`, `confirmation.expired`, `policy.blocked` | `blocked` | `policy_blocked`. |
| `resolution.ambiguous_request`, `resolution.ambiguous_target` | `needs_user_input` | `ambiguous_user_request`; ask or show candidates. |
| `resolution.target_not_found` | `needs_user_input` or `failed` | `unclassified` unless typed evidence establishes misuse, missing configuration, or an unsupported boundary; absence is not ambiguity by itself. |
| `precondition.*` missing config/credential/dependency/platform | `failed` | `missing_configuration`, except authoritative permanent platform absence may be `unsupported_or_impossible`. |
| `parser.invalid_output`, `parser.unknown_tool` | `failed` | `invalid_llm_plan`. |
| `parser.invalid_tool_arguments`, `execution.invalid_arguments`, `plan.existing_tool_not_selected` | `failed` or recovered `completed` | `existing_tool_misuse` only if terminal; no gap if recovered. |
| `execution.timeout`, `execution.rate_limited`, `budget.request_timeout` | `failed` | `timeout_or_rate_limit`. |
| `execution.provider_5xx`, `execution.network_transient` | `failed` | `transient_external_failure`. |
| `execution.exit_nonzero`, `execution.internal_error` | `failed` | `unclassified` until misuse, transient cause, or reproduced tool bug is established. |
| `verification.invariant_failed` | `failed` | `existing_tool_bug` when tied to a known tool; otherwise `invalid_llm_plan` for a completion-claim invariant. |
| `budget.max_rounds` | `failed` | `invalid_llm_plan`; this is a bounded planning failure, not a missing tool. |
| `budget.context_handoff` | `handed_off` | Normal continuation control; no gap. |
| `capability.explicitly_unsupported`, `capability.impossible_on_platform` | `failed` or `needs_capability` | Apply §4.4/§4.6; never infer from model prose alone. |
| `contract.invalid_input`, `outcome.unclassified` | `failed` or `needs_user_input` | `unclassified` unless a more specific typed rule applies. |

### 4.6 Missing-capability test

A classification is `missing_capability` only if all are true:

1. `TaskOutcome.status` is `failed`, `partial`, or `needs_capability`.
2. The required operation is represented as a structured capability key, not just prose.
3. The current registry snapshot and availability snapshot are recorded.
4. No existing tool advertises the operation at the required scope.
5. The operation is within Alfred's product and policy boundaries.
6. The outcome is not explained by configuration, credentials, target ambiguity, confirmation, timeout, rate limit, transient failure, or an existing-tool bug.
7. At least one promotion-eligible evidence source exists.

If the current flat registry cannot answer step 4, the deterministic observation remains `unclassified`. A user may create a separate `user_reported_gap` override for later review, but that does not make the deterministic classification `missing_capability`, satisfy step 4, or become generation-eligible until a semantic registry matcher confirms the absence. This keeps user importance/value judgments separate from evidence that no existing capability matches.

### 4.7 Confidence

Confidence measures evidence quality, not importance or probability of user value.

| Evidence source | Maximum confidence |
|---|---:|
| Alfred-owned typed contract/invariant | 1.00 |
| Normalized documented OS/provider status | 0.90 |
| Versioned exact detector over bounded redacted text | 0.75 |
| User manual classification | 1.00, recorded as user override |
| LLM/free-text interpretation | 0.40 and never promotion-eligible |

For a gap aggregate, use the minimum confidence among counted qualifying occurrences. Do not average weak evidence upward, and do not let recurrence raise confidence; recurrence measures frequency, not causal certainty.

Assign `missing_capability` confidence deterministically:

- 1.00: a user confirms a `user_reported_gap`, recorded as a user override; this confidence expresses the user's stated need, not deterministic registry absence, and is not sufficient by itself for generation;
- 0.85: all missing-capability tests in §4.6 pass, including a typed `plan.no_matching_capability` outcome and a semantic registry matcher (not a name-only scan);
- at most 0.75: the registry is still flat/name-only or a versioned text detector supplies any required evidence;
- at most 0.40: an LLM or free-text interpretation supplies any required evidence; this is never promotion-eligible.

Future automatic eligibility requires confidence of at least 0.85 plus the separate recurrence rule. LLM annotations do not add confidence.

### 4.8 Deduplication and lineage

Use two hashes with different stability contracts.

The classification-independent **operation lineage key** is recorded for successful and unsuccessful outcomes only when Alfred can establish a canonical operation key deterministically. Outcomes may legitimately have no operation lineage; absence must never be filled from free-form model prose merely to make a record aggregatable.

The authoritative toolkit registry owns a versioned operation-key vocabulary, semantic descriptors, and deterministic scope matcher. The matcher—not the request LLM—maps structured planner/tool contracts to canonical keys. It must return `matched`, `no_match`, or `unknown`; only `no_match` can support missing-capability classification. Registry Phase 8 or the SR-1.5 prerequisite must implement this contract and fixture-based parity tests before eligibility is enabled.

A lineage key is:

```ts
{
  lineageSchemaVersion: 1,
  requiredOperation,
  targetSystemClass,
  resourceClass,
  mutationLevel,
  touchesNetwork,
  policyScope
}
```

The versioned **evidence fingerprint** identifies one classifier interpretation:

```ts
{
  evidenceSchemaVersion: 1,
  lineageKey,
  classification,
  failureCode,
  detectorVersion,
  registrySchemaVersion
}
```

Rules:

- SHA-256 over canonical stable-key JSON;
- exclude user text, timestamps, UUIDs, secrets, tokens, exact paths, workspace names, and raw output;
- occurrence identity is separate: `requestId + toolCallId/terminalStage + code`;
- repeated retries within one request count once;
- all request outcomes, including successes, write a minimal outcome index; it includes lineage keys only when established deterministically, so “later success” can be evaluated without inventing a gap observation;
- detector/registry changes create a new evidence fingerprint linked to the same lineage key;
- suppressions and proposal families key on the stable lineage key and therefore survive detector/registry version changes;
- changing operation semantics requires a new `lineageSchemaVersion` or operation key, never a silent remap;
- exact keys are authoritative;
- optional semantic/embedding similarity may suggest potential merges in the UI but may never auto-merge, migrate a suppression, or determine eligibility.

### 4.9 Recurrence and cooldowns

Observation is cheap; generation is not.

Recommended thresholds:

- explicit user-triggered generation: may waive recurrence after one deterministic `missing_capability` result confirmed as useful by the user; a `user_reported_gap` without deterministic registry absence cannot waive the semantic-matcher requirement;
- future automatic queue eligibility: at least three distinct `requestId`s within 30 days, spanning at least two days or two sessions, confidence at least 0.85; count only qualifying failures after the most recent success, registry-availability change, resolution, or “already supported” decision for that lineage key;
- only one active proposal family per lineage key;
- 30-day generation cooldown after a failed or expired proposal;
- 90-day lineage-key suppression after rejection, with a permanent option;
- a new detector or registry version links new evidence to the existing lineage suppression and may offer a non-interruptive “review suppression” action; it never silently clears the decision;
- unresolved observations may continue to aggregate while notifications and generation are suppressed.

### 4.10 Dismissal behavior

The review UI should offer distinct decisions:

- **Not useful:** suppress generation and notifications for that lineage key for 90 days; continue store-only observations.
- **Never propose this:** permanent lineage-key suppression until manually reopened.
- **Wrong classification:** record a user correction; block eligibility until new deterministic evidence is reviewed.
- **Already supported:** link an existing tool; future matching failures route to misuse or bug classification.
- **Defer:** choose 7, 30, or custom days; require a new qualifying occurrence after the defer time before notifying again.
- **Delete sensitive provenance:** physically remove deletable excerpt blobs/artifacts while retaining only canonical-redacted digests or keyed correlation values, decisions, and audit tombstones; raw-content hashes are not retained.

User silence is never acceptance.

---

## 5. Data types

These types are contracts for implementation planning, not code to add now.

### 5.1 Task outcome and tool failure

```ts
type TaskOutcomeStatus =
  | "completed"
  | "partial"
  | "needs_user_input"
  | "needs_capability"
  | "blocked"
  | "failed"
  | "cancelled"
  | "handed_off";

interface StructuredFailure {
  stage: FailureStage;
  code: FailureCode;
  component: string;
  message: string;                 // bounded and redacted
  retryable: boolean;
  timedOut?: boolean;
  rateLimited?: boolean;
  httpStatus?: number;
  configKeysMissing?: string[];    // names only
  detector: { id: string; version: number };
}

interface TaskOutcome {
  requestId: string;
  turnId?: string;
  sessionId: string;
  status: TaskOutcomeStatus;
  completedOperationKeys: string[];     // only canonical, deterministically established keys
  requiredOperationKeys: string[];      // may be empty when no trusted mapping exists
  operationLineageKeys: string[];       // may be empty; written for success and failure when known
  terminalFailure?: StructuredFailure;
  startedAt: string;
  endedAt: string;
}
```

### 5.2 Provenance

```ts
interface SourceTaskProvenance {
  redactedTextRef?: string;             // reference to a deletable bounded blob
  redactedContentSha256: string;        // digest of canonical redacted bytes only, never raw content
  redactions: Array<{
    kind: "secret" | "credential" | "email" | "path" | "private_content";
    count: number;
  }>;
  sensitiveContextOmitted: boolean;
}

interface ToolResultEvidence {
  requestId: string;
  toolCallId: string;
  tool: string;
  attempt: number;
  success: boolean;
  failure?: StructuredFailure;
  safety: {
    mutationLevel: "read" | "mutation" | "destructive";
    touchesNetwork: boolean;
    confirmation: "none" | "confirm" | "explicit";
  };
  durationMs?: number;
  outputExcerptRef?: string;       // reference to a deletable, redacted, capped blob
  redactedOutputSha256?: string;   // digest of canonical redacted bytes only
  truncated: boolean;
}

interface GapProvenance {
  requestId: string;
  turnId?: string;
  sessionId: string;
  sourceTask: SourceTaskProvenance;
  observedAt: string;
  observedFailure: StructuredFailure;
  relevantToolResults: ToolResultEvidence[];
  parserEventIds: string[];
  registrySnapshotSha256: string;
  systemContextSha256?: string;    // no raw full context
}
```

Provenance does not require retaining raw secrets. It requires traceability to the request, sanitized task, exact typed outcome, relevant result metadata, and content hashes.

### 5.3 Gap observation and aggregate

```ts
interface GapClassificationRecord {
  category: GapClassification;
  confidence: number;
  classifier: { id: string; version: number };
  evidenceSources: Array<"typed" | "normalized" | "detector" | "user" | "llm_advisory">;
  proposalEligible: boolean;
  exclusionsApplied: string[];
  rationaleCodes: string[];
}

interface OutcomeIndexEntry {
  requestId: string;
  sessionId: string;
  endedAt: string;
  status: TaskOutcomeStatus;
  operationLineageKeys: string[];
}

interface FailureObservation {
  schemaVersion: 1;
  observationId: string;
  lineageKey?: string;                    // absent when canonical operation is unknown
  evidenceFingerprint?: string;           // absent until lineage/classification evidence is sufficient
  outcome: TaskOutcome;
  provenance: GapProvenance;
  classification: GapClassificationRecord;
  privacy: {
    containsSensitiveContent: boolean;
    generatorMayReceiveExcerpts: boolean;
    retentionClass: "metadata_only" | "standard" | "user_pinned";
  };
  recordedAt: string;
}

/**
 * Only observations with a deterministic lineageKey enter a CapabilityGap.
 * Others remain inspectable but unaggregated until an append-only
 * reclassification event establishes canonical lineage.
 */
interface CapabilityGap {
  schemaVersion: 1;
  gapId: string;
  lineageKey: string;
  evidenceFingerprints: string[];
  title: string;
  requiredOperation: string;
  targetSystemClass?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  distinctRequestCount: number;
  distinctSessionCount: number;
  observationIds: string[];
  aggregateConfidence: number;
  status: "open" | "eligible" | "suppressed" | "proposal_active" | "resolved";
  suppression?: GapSuppression;
  linkedProposalIds: string[];
  resolvedByToolId?: string;
}

interface GapSuppression {
  reason: "not_useful" | "never_propose" | "wrong_classification" | "already_supported" | "deferred" | "privacy";
  actor: "user" | "policy";
  createdAt: string;
  until?: string;
  lineageKey: string;
  createdUnderDetectorVersion: number;
  note?: string;
}
```

### 5.4 Proposal and revision

```ts
type ProposalKind =
  | "declarative_local_read_adapter"
  | "declarative_http_read_adapter"
  | "declarative_transform_adapter"
  | "typescript_tool"; // deferred, policy-disabled in MVP

type ProposalState =
  | "draft"
  | "ready_for_review"
  | "accepted_for_adoption"
  | "adoption_change_prepared"
  | "adopted"
  | "rejected"
  | "deferred"
  | "expired"
  | "superseded"
  | "quarantined";

interface RiskPosture {
  mutationLevel: "read" | "mutation" | "destructive";
  touchesNetwork: boolean;
  confirmation: "none" | "confirm" | "explicit";
  dataEgress: "none" | "fixed_origin";
  approvedNetworkOrigins: string[];
  egressInputFields: string[];
  requestedPermissions: string[];
  effectivePermissions: string[];
  computedByPolicyVersion: string;
}

interface ProposalManifest {
  schemaVersion: 1;
  proposalId: string;
  gapId: string;
  lineageKey: string;
  kind: ProposalKind;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requestedPermissions: string[];       // untrusted request; may only be narrowed
  requestedNetworkOrigins: string[];    // untrusted request; exact origins only
  declaredPosture?: {                   // advisory generator claim, never authoritative
    mutationLevel: "read" | "mutation" | "destructive";
    touchesNetwork: boolean;
  };
  adapterId: string;
  adapterVersion: string;
  dependencies: Array<{ name: string; version: string; sha256: string }>;
  limitations: string[];
  generatedAt: string;
}

interface ProposalRevision {
  proposalId: string;
  revision: number;
  parentRevision?: number;
  manifestSha256: string;
  contentSha256: string;
  sourcePaths: string[];
  authorTestPaths: string[];
  generator: {
    provider: string;
    model: string;
    promptTemplateVersion: string;
    promptSha256: string;
    contextManifestSha256: string;
    providerConsentId?: string;             // required for non-local provider egress
    inputTokens?: number;
    outputTokens?: number;
  };
  createdAt: string;
  immutable: true;
}

type ProposalJobState =
  | "queued"
  | "generating"
  | "generated"
  | "validating"
  | "repairing"
  | "completed"
  | "failed"
  | "interrupted";

interface ProposalFamily {
  proposalId: string;
  gapId: string;
  lineageKey: string;
  state: ProposalState;
  currentRevision: number;
  activeJobId?: string;
  linkedJobIds: string[];
  latestValidationRunId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProposalJob {
  jobId: string;
  proposalId: string;
  state: ProposalJobState;
  revision: number;
  generationAttempt: number;
  semanticRepairCount: number;
  validationRunCount: number;
  lease?: { ownerId: string; acquiredAt: string; expiresAt: string };
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWallMs: number;
  };
  lastReasonCode?: string;               // e.g. job.interrupted
  createdAt: string;
  updatedAt: string;
}
```

In the MVP, `dependencies` must be empty and `kind: "typescript_tool"` is rejected by policy.

### 5.5 Validation

```ts
type ValidationGateStatus = "passed" | "failed" | "skipped" | "error";

interface ValidationGateResult {
  gateId: string;
  gateVersion: string;
  status: ValidationGateStatus;
  required: boolean;
  evidenceClass: "deterministic" | "author_test" | "independent_fixture" | "llm_advisory";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  command?: string[];              // trusted runner command, never proposal script
  exitCode?: number;
  stdoutPath?: string;
  stderrPath?: string;
  outputSha256?: string;
  resourceUsage?: { cpuMs?: number; peakMemoryBytes?: number; outputBytes: number };
  findings: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
}

interface ValidationResult {
  validationRunId: string;
  proposalId: string;
  revision: number;
  contentSha256: string;
  policyVersion: string;
  validatorVersion: string;
  freshness: ValidationFreshness;       // all versions/controls required at review and acceptance
  effectiveRisk: RiskPosture;           // platform-derived, never copied from generator
  sandboxBackend: string;
  sandboxControlsEnforced: string[];
  gates: ValidationGateResult[];
  overall: "passed_required_gates" | "failed" | "inconclusive";
  residualLimitations: string[];
  artifactRoot: string;
  completedAt: string;
}
```

### 5.6 Adoption decision

```ts
type AdoptionDecisionKind = "accept_for_adoption" | "reject" | "defer" | "reopen";

interface ProposalReviewGrant {
  grantId: string;
  proposalId: string;
  revision: number;
  contentSha256: string;
  reviewedRootAliases: string[];
  reviewedNetworkOrigins: string[];
  reviewedEgressFields: string[];
  reviewedPermissions: string[];
  runtimeDisclosurePolicy: "non_sensitive_platform_values_only" | "explicit_per_invocation";
  grantedBy: "local_user";
  grantedAt: string;
}

interface RuntimeCapabilityGrant {
  runtimeGrantId: string;
  stableToolId: string;
  registryDescriptorSha256: string;
  implementationCommit: string;
  approvedRootAliases: string[];
  approvedNetworkOrigins: string[];
  approvedEgressFields: string[];
  effectivePermissions: string[];
  runtimeDisclosurePolicy: "non_sensitive_platform_values_only" | "explicit_per_invocation";
  grantedBy: "local_user";
  grantedAt: string;
}

interface ValidationFreshness {
  policyVersion: string;
  validatorVersion: string;
  adapterId: string;
  adapterVersion: string;
  registrySnapshotSha256: string;
  fixtureSuiteVersion: string;
  sandboxBackend: string;
  requiredSandboxControls: string[];
}

interface AdoptionDecision {
  decisionId: string;
  proposalId: string;
  revision: number;
  contentSha256: string;
  decision: AdoptionDecisionKind;
  actor: "local_user";
  decidedAt: string;
  note?: string;
  deferUntil?: string;
  validationRunId?: string;
  validationFreshness?: ValidationFreshness;
  proposalReviewGrantId?: string;       // review intent only; never runtime authorization
  runtimeCapabilityGrantId?: string;    // populated only after reviewed integration
  implementationReference?: {
    repository: string;
    branch?: string;
    commit?: string;
    pullRequestUrl?: string;
    diffSha256?: string;
  };
}
```

An acceptance must bind to an exact proposal revision and content hash. Any changed byte invalidates that acceptance.

---

## 6. Proposal lifecycle and state machine

Do not overload one state machine with observations, gap aggregation, generation jobs, review decisions, and live installation.

### 6.1 Observation lifecycle

```txt
observed -> classified -> aggregated
                      -> suppressed
                      -> retained_unclassified
```

- `observed`: immutable structured outcome and provenance have been written.
- `classified`: deterministic classifier version and exclusions have been applied.
- `aggregated`: occurrence is linked to an operation lineage key and its versioned evidence fingerprint.
- `suppressed`: retained for audit but excluded by policy/user decision.
- `retained_unclassified`: evidence is insufficient; no proposal path.

Classification corrections append a new classification event; they do not overwrite original evidence.

### 6.2 Gap aggregate lifecycle

```txt
open -> eligible -> proposal_active -> resolved
  |        |              |
  +------> suppressed <---+
             |
             +-> open  [expiry/manual reopen + reclassification]
```

- `open -> eligible`: deterministic missing-capability confidence and recurrence rules pass.
- `eligible -> proposal_active`: an explicit user request, or a future opt-in background policy, creates exactly one proposal family.
- `proposal_active -> resolved`: an adopted live toolkit capability is linked, or the user marks the need obsolete.
- any non-resolved state may become `suppressed` by user or policy.
- `suppressed -> open`: a timed suppression expires or the user explicitly reopens it; current evidence is reclassified before eligibility is reconsidered.
- recurrence after resolution creates a linked regression record for review; it does not reopen history or generate silently.

### 6.3 Proposal family and job lifecycles

A proposal family owns review/adoption state across retries and replacement jobs:

```txt
draft -> ready_for_review -> accepted_for_adoption -> adoption_change_prepared -> adopted
                        \-> rejected -> ready_for_review  [explicit reopen only]
                        \-> deferred -> ready_for_review  [expiry + new occurrence or explicit reopen]
                        \-> expired  -> ready_for_review  [explicit reopen only]
                        \-> superseded

any pre-adoption nonterminal state -> quarantined  [integrity/policy violation]
```

A bounded job owns generation/validation execution only:

```txt
queued -> generating -> generated -> validating -> completed
                    ^                 |
                    +---- repairing <-+
queued/generating/generated/validating/repairing -> failed | interrupted
```

### 6.4 Transition rules

| Owner/from | To | Guard |
|---|---|---|
| family: none | `draft` | Gap is deterministically `missing_capability`; no active identical family; user explicitly requested generation in Stages 2-4. A `user_reported_gap` alone is insufficient. |
| job: none | `queued` | Draft family exists; no active job; generation policy permits the exact gap/revision. |
| job: `queued` | `generating` | Job lease acquired; budget available; generator policy and context manifest exist. |
| job: `generating` | `generated` | Output parses, file/path limits pass, revision is hashed, atomically stored, and made immutable. |
| job: `generating` | `failed` or `interrupted` | Provider error, budget exhaustion, malformed output after one format repair, crash, or stale lease. |
| job: `generated` | `validating` | Trusted validator pins exact content hash. |
| job: `validating` | `repairing` | Failure is explicitly repairable; attempts remain; no permission widening or non-repairable security violation. |
| job: `repairing` | `generated` | A new immutable revision is created. It never mutates the old revision. |
| job: `validating` | `completed`; family: `draft` | Every required deterministic gate passed for the exact revision; no required gate skipped; validation freshness tuple recorded. |
| job: `validating` | `failed` | Non-repairable gate failed or repair budget exhausted. |
| family: `draft` | `ready_for_review` | Completed validation is fresh for current policy, validator, adapter, registry, fixtures, and sandbox requirements. |
| family: `ready_for_review` | `accepted_for_adoption` | Explicit decision and any `ProposalReviewGrant` bind to revision/hash; referenced validation is still fresh. The review grant records intent only and is never runtime authorization. No live change occurs. |
| family: `ready_for_review` | `rejected` | Explicit user decision; suppression recorded. |
| family: `ready_for_review` | `deferred` | Explicit user duration; no reminders before expiry. |
| family: `deferred` | `ready_for_review` | Defer time elapsed plus a new qualifying occurrence, or explicit user reopen, and validation is still fresh. |
| family: `deferred`, `rejected`, or `expired` | `draft` | Explicit reopen when validation is absent or stale; a new bounded validation job is required. |
| family: `rejected` or `expired` | `ready_for_review` | Explicit user reopen only when validation is still fresh. |
| family: `ready_for_review` | `expired` | 90 days without review; artifacts remain until retention/delete policy acts. |
| family: `ready_for_review` | `superseded` | Gap resolved elsewhere or user explicitly replaces the family; revisions remain inspectable. |
| family: `accepted_for_adoption` | `adoption_change_prepared` | A separate normal developer workflow records a branch/commit/diff. The proposal system itself does not edit the repository. |
| family: `adoption_change_prepared` | `adopted` | Reviewed code is merged; normal registry reports stable tool ID after restart; implementation reference is recorded. |
| family: pre-adoption nonterminal | `quarantined` | Hash mismatch, forbidden file, corrupt audit/state, stale security policy that cannot be revalidated, or attempted boundary escape. Adopted code uses the normal toolkit/rollback path. |

If any validation-freshness component changes while a family is `ready_for_review`, it returns to `draft` and requires revalidation before review or acceptance.

### 6.5 Repair limits

- one output-format repair;
- at most two semantic repair revisions after the initial revision;
- at most three validation runs per proposal job;
- repeated identical finding codes end the job;
- any requested permission widening ends automatic repair and requires a new explicit user request;
- every repair reruns all gates, not only the failed gate;
- crashes do not auto-resume model calls; stale jobs become `failed` with reason code `job.interrupted` and require explicit retry.

### 6.6 Terminal semantics

- `accepted_for_adoption` means “the user believes this is worth taking through normal development.”
- `adopted` means reviewed code entered the normal toolkit through a repository change and startup, not runtime mutation.
- `passed_required_gates` means bounded checks passed; it does not mean safe or correct.
- `rejected`, `expired`, `failed`, and `quarantined` never trigger automatic regeneration.

---

## 7. Generator context contract

### 7.1 Generator role

The generator produces inert proposal files. It has no shell, **model-controlled network tools**, registry, confirmation, installation, environment, home-directory, or live-tool execution capability. A remote LLM provider call is itself network egress from Alfred and must not be described as network-free.

Before sending context to a non-local model, show and record the provider, model, data classes included, provider retention posture if known, and an explicit user consent for that generation job. A local model may use a persistent preference, but context exclusions still apply.

Prefer a single LLM call receiving a preassembled context and returning a strict JSON file map. If more context is needed, the job fails with `context_insufficient` in the MVP rather than granting repository browsing.

### 7.2 Allowed context

A generator context manifest may contain:

1. proposal schema and allowed proposal kinds;
2. the exact declarative adapter schema and policy version;
3. one gap aggregate summary;
4. selected, redacted provenance from qualifying observations;
5. structured failure codes and bounded relevant result excerpts;
6. current toolkit metadata: names, descriptions, schemas, semantic capability tags, risk posture, availability, and missing configuration names;
7. reserved names and collision rules;
8. trusted adapter documentation and examples;
9. independent acceptance fixtures supplied by the user or platform, clearly marked as immutable;
10. previous revision and structured validator findings during repair;
11. fixed output, token, file-count, and runtime budgets.

### 7.3 Excluded context

Never include by default:

- `process.env` or an environment dump;
- API keys, OAuth tokens, cookies, Keychain data, pending confirmations, or daemon auth tokens;
- raw `.env`, `.ssh`, cloud credentials, full home-directory paths, or system configuration;
- unrelated conversation history, profile memory, email, documents, terminal content, or browser content;
- raw full system context;
- `.git`, `node_modules`, package caches, lockfile internals, or arbitrary repository history;
- current live registry implementation objects or writable paths;
- instructions embedded inside user/tool/web/email content.

External and user content is delimited and labeled **untrusted evidence, not instructions**.

### 7.4 Repository read budget

For declarative proposals, the generator should receive no arbitrary repository access. A deterministic context builder may select:

- up to 12 allowlisted files;
- at most 250 KiB total before redaction;
- only schema, adapter SDK, policy, fixture, and relevant tool-contract files;
- no file outside the repository realpath;
- no symlinks, hardlinks, binary files, or paths containing secret/config patterns.

Every selected path and content hash is recorded in `context-manifest.json`. If later interactive context requests are introduced, a trusted broker applies the same allowlist and budgets; the model never receives a general `read_file` tool.

### 7.5 Output contract

- strict JSON object, no prose-wrapped filesystem writes;
- canonical relative paths from an allowlist;
- maximum 12 files and 256 KiB total;
- no absolute paths, `..`, symlinks, hardlinks, device files, archives, or Unicode-confusable tool names;
- unknown manifest fields rejected;
- duplicate JSON keys rejected before normal parsing;
- output lands in a staging directory and is atomically committed only after intake checks.

### 7.6 Budgets

Recommended explicit-generation budget:

- maximum 32,000 input tokens;
- maximum 8,000 output tokens for the initial revision;
- maximum 4,000 output tokens per repair;
- maximum 16,000 total output tokens across the job;
- maximum 90 seconds per model call;
- maximum 15 minutes wall time for generation plus validation;
- no more than two semantic repairs.

Budgets should be recorded, not silently expanded.

---

## 8. Sandbox and threat model

### 8.1 Trust boundaries

1. **Live Alfred runtime:** trusted application code and registry.
2. **Observation journal:** trusted structure containing untrusted/redacted content.
3. **Generator:** untrusted producer, even when using the same model provider as Alfred.
4. **Proposal store:** quarantine/inert bytes, never an import root.
5. **Validator control plane:** trusted deterministic code.
6. **Validation worker:** isolated, disposable process or environment.
7. **Adoption repository workflow:** normal reviewed development, outside proposal automation.

There must be no direct path from generator or proposal store to the live registry.

### 8.2 Storage layout

Canonical machine-local storage:

```txt
~/.alfred/capabilities/                  # mode 0700
  observations/
    YYYY-MM-DD.jsonl                     # mode 0600; metadata/events, append-only by convention
  excerpts/
    <random-blob-id>                     # mode 0600; deletable canonical-redacted content
  gaps/
    <gap-id>/
      snapshot.json
      audit.jsonl
  suppressions/
    events.jsonl
  proposals/
    <proposal-id>/
      state.json
      audit.jsonl
      revisions/
        0001/
          manifest.json
          context-manifest.json
          source/                        # mode 0444 after commit
          author-tests/                  # mode 0444 after commit
          content.sha256
      validation/
        <run-id>/
          result.json
          gates/
            <gate-id>.json
            stdout.log
            stderr.log
  staging/
    <job-id>/                             # never scanned; removed/quarantined after crash
  quarantine/
    <proposal-id>-<timestamp>/
```

Repository storage:

- architecture and source code only under the repository;
- no generated proposal source under `src/`, `test/`, `web/`, or any registry path;
- no repository-level `proposals/` directory watched by build tooling;
- adoption uses a separate normal branch/worktree only after explicit user action outside the proposal lifecycle.

Filesystem rules:

- server-generated random IDs;
- `lstat` plus realpath/no-follow containment checks;
- reject symlinks and hardlinks;
- atomic temp-file, fsync where practical, rename;
- immutable content-addressed revisions;
- hash checks before every validation and review read;
- directory 0700, mutable metadata 0600, committed proposal sources 0444;
- source revisions are never edited in place.

### 8.3 MVP proposal posture

MVP proposals are declarative and read-only:

- `mutationLevel: "read"` only;
- network is either absent or constrained to a user-approved fixed HTTPS origin in the manifest;
- every input field interpolated into a request path/query is declared as egress, type/length constrained, displayed during review, and forbidden from accepting secret/credential/private-content field classes;
- no custom arbitrary headers, ambient credentials, secret interpolation, open redirects, or user-controlled origins;
- local reads use user-approved logical root aliases, never absolute paths;
- transformations use a trusted expression/selector language with no code evaluation;
- no child-process adapter in the first version;
- no dependencies.

A proposal asking for mutation, destructive access, unrestricted network, shell, or arbitrary TypeScript fails policy and cannot reach `ready_for_review`. A fixed-origin network read may use `confirmation: "none"` only for platform-assigned, non-sensitive literal/enumerated input classes covered by a runtime grant bound to the actual stable tool ID, registry descriptor hash, and reviewed implementation commit. User-derived, tool-output-derived, memory-derived, private, secret, credential, or unknown-class values require an exact per-invocation disclosure preview and `explicit` confirmation. Proposal-authored labels are never authoritative. “Read” must never be presented as “no disclosure risk.”

Normative trusted HTTP client contract for any allowed network adapter:

- canonicalize an exact `https://host:port` origin; reject URL credentials and non-default ports unless separately granted;
- resolve every A/AAAA answer and reject loopback, private, link-local, multicast, unspecified, reserved, metadata-service, IPv4-mapped IPv6, and other non-global destinations;
- connect to one validated/pinned address without a second unvalidated DNS lookup while preserving TLS SNI and hostname verification;
- disable redirects in the MVP; a later redirect feature must repeat full origin, grant, DNS, address, and egress validation on every hop with a strict hop cap;
- enforce response byte/time limits and never attach ambient credentials or cookies;
- test the resolver/connector boundary, encoded address forms, rebinding attempts, and indirect sensitive-value propagation.

### 8.4 Why declarative adapters first

Declarative adapters constrain behavior to reviewed host operations. The proposal selects data and schemas; trusted code owns I/O, limits, risk, and confirmation.

Recommended initial adapter classes:

- bounded local JSON/CSV/text read under a user-approved root alias;
- fixed-origin HTTPS GET with an adoption-time origin grant, explicit input-to-request egress map, destination trust display, SSRF-safe resolution, and recorded fixture responses;
- deterministic JSON extraction, field mapping, filtering, and pagination;
- pure output formatting.

Do not generate workflow wrappers merely because the model failed to use existing tools. That is `existing_tool_misuse`, not a missing capability.

### 8.5 Arbitrary code reality on macOS

A Node `vm`, worker thread, child process timeout, output cap, or scrubbed environment is not a security boundary. macOS does not provide Linux namespaces, seccomp, and cgroups. `sandbox-exec`/Seatbelt is deprecated or insufficient as the sole product boundary.

Therefore:

- arbitrary generated TypeScript is disabled in the MVP;
- later code-bearing proposals require a separately evaluated VM/container or dedicated low-privilege service with a capability broker;
- if no backend can attest filesystem, environment, network, process, CPU, memory, and output controls, code validation is `inconclusive` and the proposal cannot become ready;
- validation must never fall back to unrestricted local Node execution.

### 8.6 Required isolation controls for any future code worker

Recommended fail-closed defaults:

| Resource | Default limit |
|---|---|
| Proposal mount | read-only |
| Writable filesystem | one empty scratch root, maximum 64 MiB |
| Repository/home | not mounted |
| Environment | fixed allowlist only; empty temporary `HOME`; no inherited secrets |
| Network | disabled; later only brokered test endpoints |
| Processes | child process creation disabled |
| CPU | 30 CPU seconds per gate, 120 seconds total |
| Wall time | 60 seconds per gate, 5 minutes validation total |
| Memory | 512 MiB maximum |
| Open files | 64 maximum |
| Output | 1 MiB per gate, 5 MiB total artifacts |
| Inputs | immutable hash-pinned revision and fixtures |

The sandbox backend must report which controls it actually enforced. A config file claiming a limit is not evidence of enforcement.

Declarative proposals are also hostile input. After a minimal control-plane byte/file-count prefilter, schema parsing, selector/expression compilation, fixture execution, and author tests run in a disposable worker with no repository, home, secret, proposal-store-write, audit-store-write, or network access. The trusted control plane communicates through a narrow bounded protocol and is the only component allowed to write validation records.

### 8.7 Static deny rules for future TypeScript

Use AST/module-graph checks, not only regex. Deny:

- `child_process`, shell execution, `bash -c`, command strings, `osascript`, `launchctl`;
- `eval`, `Function`, dynamic import, dynamic require, `vm`, WebAssembly, native addons;
- direct `fs`, `net`, `http`, `https`, `tls`, `dns`, `dgram`, `worker_threads`, `cluster`, `module`;
- `process.env`, `process.binding`, unrestricted `process`, home-directory discovery, Keychain access;
- prototype mutation, loader hooks, source maps referring outside the proposal, and package lifecycle scripts;
- absolute paths, traversal, symlinks/hardlinks, sockets, and device files;
- unrestricted `fetch`, redirects, loopback, RFC1918, link-local, multicast, metadata services, and DNS rebinding;
- arbitrary package dependencies.

Imports should be limited to a capability SDK plus an exact, pre-vendored dependency allowlist. No install command runs during generation or validation.

### 8.8 Bash-wrapper rule

Generated bash wrappers are prohibited.

If a future trusted command adapter is approved:

- it uses a fixed executable and argument array, not a shell string;
- the adapter's static posture is a minimum;
- the final rendered operation is classified again at runtime;
- the more restrictive static/dynamic posture wins;
- network mutations and destructive operations require `explicit` confirmation;
- a wrapper cannot declare itself read-only to bypass the runtime classifier;
- unknown commands fail closed, unlike the current bash default-to-read behavior.

### 8.9 Threats and controls

| Threat | Control |
|---|---|
| Prompt injection in request/tool/web/email content | Delimit as data, redact, no generator tools, deterministic policy. |
| Secret exfiltration | No ambient env/home/credentials; context manifest; output redaction and scanning. |
| Proposal modifies live registry/source | Separate root; no watcher/import; no mutation API; OS permissions and path containment. |
| Dependency supply chain/postinstall | Empty MVP dependency set; later exact pre-vendored allowlist and hashes; no install scripts. |
| Shell/child-process escape | Prohibit generated shell and child processes; AST/module checks; sandbox enforcement. |
| Symlink/hardlink escape | `lstat`, realpath/no-follow, link rejection, atomic writes. |
| SSRF/private network access | Network off in validation; a normative trusted-client contract pins validated DNS answers, preserves TLS hostname verification, and disables redirects in the MVP. |
| Disclosure to an allowed public origin | Adoption-time origin grant, visible destination ownership/trust, explicit egress-field map, secret/private field prohibition, no ambient credentials. |
| CPU/memory/output/fork bomb | Declarative MVP; later VM/container limits and output caps. |
| Forged validation evidence | Validator writes artifacts, pins hashes, distinguishes author tests, append-only audit. |
| Approval-to-adoption TOCTOU | Acceptance bound to revision/hash; revalidate exact bytes before normal code review. |
| Notification social engineering | Deterministic wording, exact permissions/evidence, no one-click install. |
| Proposal spam/cost exhaustion | Recurrence thresholds, quotas, cooldowns, explicit generation first. |
| Corrupt/crashed state | Atomic writes, immutable revisions, stale lease failure, quarantine, never auto-resume. |
| Same-user local attacker | Out of scope for strong isolation; hashes detect some drift but are not tamper-proof against the same OS user. |

### 8.10 Failure recovery and audit

- append every state transition with actor, timestamp, prior/next state, revision hash, policy version, sequence number, prior-event hash, and reason code;
- preserve validation logs and command arrays for inspection;
- redact secrets before persistence and log display; persistent digests cover canonical redacted bytes only, never raw content;
- store deletable task/result excerpts as separately referenced blobs, not inline in append-only journals; deletion removes the blob and appends a tombstone;
- only a provably truncated final append may be ignored in a non-authoritative observation log;
- a malformed interior line, sequence/hash-chain break, or corruption in suppression, decision, proposal, state, or audit journals makes the affected aggregate read-only/quarantined and blocks generation, validation, notification, and decisions until explicit repair;
- materialized snapshots are rebuildable from valid event journals and existing excerpt blobs; missing deleted blobs are represented by tombstones;
- incomplete staging directories are never promoted on startup;
- stale running jobs become failed/interrupted, not resumed automatically;
- hash mismatch moves the entire family to quarantine;
- audit hashes detect accidental drift but are not described as tamper-proof.

Recommended retention:

- redacted observation metadata: until gap deletion/resolution policy removes it;
- bounded tool-output excerpts: 30 days by default;
- hashes, codes, timestamps, decisions, and minimal provenance: retained with the gap/proposal;
- validation logs: 90 days unless user pins the proposal;
- expired proposal bytes: retained until explicit deletion or a separately configured retention job;
- deletion writes a tombstone so dismissal and audit behavior remain understandable.

---

## 9. Validation pipeline

### 9.1 Principle

Validation answers: “What bounded checks did the platform observe for this exact hash under this policy?” It does not answer: “Is this tool safe and correct?”

### 9.2 Gates

1. **Intake and content pinning**
   - verify proposal/revision IDs and hashes;
   - reject links, devices, archives, oversized files, duplicate names, reserved names, and path escapes;
   - canonicalize the manifest and record the exact hash.

2. **Schema validation**
   - strict manifest and adapter schema;
   - unknown/duplicate keys rejected;
   - tool name normalization and Unicode-confusable checks;
   - input/output JSON schemas validated against size/depth limits.

3. **Policy and risk derivation**
   - derive effective operations and permissions from the trusted adapter;
   - derive `mutationLevel`, `touchesNetwork`, and confirmation;
   - choose the more restrictive declared/computed result;
   - reject unsupported MVP posture or registry-name collisions.

4. **Dependency closure**
   - MVP requires zero dependencies;
   - later imports must resolve only to exact pre-vendored allowlist hashes;
   - package scripts, native addons, network install, and proposal-supplied package-manager config are forbidden.

5. **Static security checks**
   - scan all content and, for future code, parse AST and module graph;
   - reject dangerous Node APIs, shell, dynamic code, environment access, unrestricted paths/network, and loader tricks;
   - security-policy findings are non-repairable if the repair would widen permissions.

6. **Type/schema compilation**
   - declarative MVP: compile the spec through a trusted adapter compiler and typecheck the generated integration envelope with a centrally owned `tsconfig`;
   - future TypeScript: `tsc --noEmit` against a centrally owned config and SDK; never use a proposal-supplied build config or script.

7. **Author tests**
   - run only in the applicable sandbox/fixture harness;
   - label as `author_test` evidence;
   - passing them is necessary where present but never sufficient.

8. **Independent contract tests**
   - platform-owned schema tests;
   - deterministic positive, negative, boundary, and malformed-input fixtures;
   - permission-denial tests;
   - output size and redaction tests;
   - adapter-specific destination/path tests.

9. **Acceptance fixtures**
   - use user/platform-supplied expected behavior that the generator could not edit;
   - compare exact or normalized outputs;
   - if no independent expected behavior exists, validation is `inconclusive`, not passed.

10. **Resource and isolation checks**
    - deadlines, output caps, scratch limits, no ambient env, no network, no process creation;
    - record sandbox enforcement evidence.

11. **Risk compatibility check**
    - verify roadmap derivation:
      - read → `none`;
      - local mutation → `confirm`;
      - network mutation → `explicit`;
      - destructive → `explicit`;
    - verify any dynamic command path is classified at final runtime rendering.

12. **Report and content recheck**
    - rehash revision after validation;
    - write immutable gate artifacts and a summary;
    - only then transition to `ready_for_review`.

### 9.3 Independent evidence and circular tests

The generator may create examples and tests, but those establish only internal consistency.

Independent evidence must come from at least one of:

- user-supplied input/output examples captured before generation;
- platform-owned adapter conformance suites;
- recorded sanitized fixtures whose expected outcome was produced by a trusted existing system or manually approved;
- deterministic properties derived from the schema, such as no unknown fields, bounded output, idempotent pure transforms, or permission denial;
- differential comparison against an authoritative implementation in an isolated fixture environment.

A second LLM reviewer is advisory and cannot satisfy an independent deterministic gate.

### 9.4 Repair diagnostics

Give the repair model:

- finding codes;
- sanitized messages;
- affected proposal-relative paths and bounded line ranges;
- expected schema/policy rule;
- previous immutable revision.

Do not give it host paths, raw environment, credentials, unrelated logs, or unrestricted stack traces.

### 9.5 Evidence language

Alfred may say a proposal “passed automated proposal validation” only when:

- the displayed revision hash equals the validated hash;
- every required gate passed;
- no required gate was skipped;
- effective permissions and risk were derived by the platform;
- at least one independent acceptance/contract fixture passed;
- the sandbox attested all controls required for that proposal kind;
- logs and gate artifacts are stored and inspectable.

Recommended notification text:

> Sir, your request at 3:00 PM exposed a recurring capability gap. I generated an inert adapter proposal for it. Schema, policy, type, and independent fixture checks passed for revision `abc123`. It has not been installed, registered, or used on live data. It is a local read proposal. Would you like to review it?

For a network-read proposal, the deterministic template instead names the exact destination origin and fields that would leave the machine. It must not use “read-only” as shorthand for harmless.

The review must also state:

> Automated checks do not prove real-world correctness, security after adoption, usefulness, or API compatibility beyond the recorded fixtures.

Never say simply “the tool is safe,” “the capability works,” or “I fixed myself.”

---

## 10. User review and adoption UX

### 10.1 Review card

A ready proposal should show:

- the original redacted task and timestamp;
- request/session/turn provenance links;
- classification and confidence;
- recurrence count and dates;
- why this was judged a missing capability rather than another category;
- proposal kind and exact revision hash;
- requested and effective permissions;
- local paths/root aliases and network origins;
- mutation/network/confirmation posture;
- files and manifest diff between revisions;
- deterministic validation gates, versions, durations, and logs;
- author tests clearly separated from independent tests;
- limitations and untested behavior;
- repair history and budget usage;
- explicit statement that nothing is installed, enabled, registered, or live.

### 10.2 Decisions

Actions:

- **Review files and evidence**;
- **Accept for normal adoption work**;
- **Reject — not useful**;
- **Reject — wrong approach**;
- **Already supported** and choose a live tool;
- **Wrong classification** and choose the correct category;
- **Defer 7/30/custom days**;
- **Delete sensitive excerpts**;
- **Export proposal bundle** for a developer review.

There is no “Install” button.

### 10.3 Adoption flow

1. User accepts an exact revision for adoption; any `ProposalReviewGrant` records review intent only.
2. Alfred records `accepted_for_adoption`; no filesystem or registry mutation follows, and the proposal review grant cannot authorize runtime I/O.
3. The user later starts a normal development task to implement/port the accepted proposal.
4. A developer inspects the gap, proposal, tests, and validation artifacts.
5. The developer writes or copies reviewed code into a separate branch/worktree using normal repository controls.
6. Normal typecheck, tests, security review, and code review run against the actual integration.
7. Risk metadata is defined in the authoritative toolkit registry; new adopted tools default disabled until the normal toolkit permission flow completes.
8. Code is merged through the normal process and the exact merge commit plus registry descriptor hash are known.
9. Outside the proposal subsystem, the user reviews the actual integrated tool contract and creates a `RuntimeCapabilityGrant` bound to stable tool ID, registry descriptor hash, and implementation commit.
10. Alfred loads/enables the normal registry capability only when that runtime grant matches; otherwise it remains unavailable.
11. The proposal record is reconciled to `adopted` using the repository commit, stable tool ID, descriptor hash, and runtime grant reference.

Even after acceptance, generated bytes are not trusted source. The implementation may differ substantially, so proposal review grants never carry forward as runtime authorization.

### 10.4 Notification queue

Default delivery:

- always available in the dashboard inbox;
- macOS notification at most once per day for capability proposals;
- speech disabled by default and separately opt-in;
- never interrupt during mute, meetings, uncertain meeting state, active microphone use, or another urgent interaction;
- explicit user-triggered generation may update the open review screen immediately without an interrupt;
- dedupe by proposal revision hash so the same ready result is announced once;
- deferred/rejected/suppressed items do not reappear before their guards allow it;
- default to a digest if multiple proposals become ready.

Future background mode should be stricter: maximum one ready-proposal interruption per day and one per lineage key per 30 days.

### 10.5 Deterministic wording

Generate notification wording from structured provenance and validation records, not another freeform LLM call. This prevents overclaiming and social-engineering language.

---

## 11. Dashboard, API, and event integration plan

### 11.1 Dashboard information architecture

After the React app exists, place this under the Tools/Capabilities area rather than creating a marketplace:

```txt
ToolsPage
  Active tools
  Capability gaps
  Proposals
```

Work Radar may show counts and ready-review signals, but it should link into this page and use the shared proactive event stream.

Views:

- gap list with category, confidence, recurrence, status, suppression;
- gap detail with provenance timeline and user correction controls;
- proposal list with lifecycle state and risk posture;
- proposal detail with revisions, diff, validation matrix, logs, limitations, and decisions;
- audit timeline.

### 11.2 API

Recommended local API:

```txt
GET  /api/capability-gaps
GET  /api/capability-gaps/:gapId
POST /api/capability-gaps/:gapId/classification-decision
POST /api/capability-gaps/:gapId/suppression
POST /api/capability-gaps/:gapId/proposals       # explicit generation request

GET  /api/capability-proposals
GET  /api/capability-proposals/:proposalId
GET  /api/capability-proposals/:proposalId/revisions/:revision
GET  /api/capability-proposals/:proposalId/validation/:runId
GET  /api/capability-proposals/:proposalId/artifacts/:artifactId
POST /api/capability-proposals/:proposalId/validate
POST /api/capability-proposals/:proposalId/decision
```

API constraints:

- the capability API and process have no repository/registry write handle or adoption executor, and no transition can mutate live runtime/source/registry state;
- no install/register/enable/execute endpoint, as an additional naming defense;
- every capability API enforces a loopback `Host` allowlist, rejects DNS-rebinding hostnames, emits no permissive CORS headers, and applies safe response/content types;
- before any mutating capability API ships, additionally enforce exact same-origin `Origin` validation, JSON-only/non-simple requests, and a server-generated CSRF/session capability token delivered through same-origin hydration and required in a custom header;
- reject foreign or missing browser origins where an origin is expected and tokenless/stale mutation requests; rate limiting is additional abuse control, not authorization;
- keep this anti-CSRF/session control distinct from broad remote-user authentication, which remains outside the localhost-only roadmap;
- artifact IDs map through a server-side manifest, never arbitrary paths;
- all mutations use expected state/revision/hash to prevent stale decisions;
- invalid transitions return typed conflict errors;
- task text and logs are omitted from list responses;
- source and logs are returned as attachments with strict path/caching/content-type handling;
- rate-limit generation/validation endpoints even on localhost;
- localhost-only posture remains, consistent with the standalone roadmap.

### 11.3 Hydration

Extend `/dashboard/state` only with small summary counts:

```ts
capabilities: {
  openGapCount: number;
  eligibleGapCount: number;
  generatingCount: number;
  readyForReviewCount: number;
}
```

Detailed records use dedicated APIs. Do not embed proposal source or verbose logs in hydration.

### 11.4 Events

After `src/alfred-2/events.ts` exists, add sanitized events:

```ts
| { type: "capability-gap:observed"; requestId: string; gapId: string; category: GapClassification }
| { type: "capability-gap:eligible"; gapId: string; occurrenceCount: number }
| { type: "capability-proposal:queued"; proposalId: string; gapId: string }
| { type: "capability-proposal:generation-start"; proposalId: string; revision: number }
| { type: "capability-proposal:validation-done"; proposalId: string; revision: number; overall: string }
| { type: "capability-proposal:ready-for-review"; proposalId: string; revision: number }
| { type: "capability-proposal:decision"; proposalId: string; decision: AdoptionDecisionKind }
```

Events carry IDs and status, not source task, tool output, code, or secrets. SSE reconnect still hydrates from APIs; events are not the durable store.

### 11.5 Proactive integration

Later add a `capability_proposal` proactive kind or a generic capability-review event. Reuse:

- mute/meeting/microphone policy;
- dashboard/notification/speech delivery decisions;
- privacy flags;
- dedupe keys;
- global interruption cooldowns.

Add a capability-specific presentation cooldown. Do not reuse proactive storage for occurrence history, proposal state, generation leases, or retry budgets.

---

## 12. Proposed files and modules

Stage 1:

```txt
src/alfred-2/capabilities/
  types.ts                 # outcomes, observations, gaps, common IDs
  failure-codes.ts         # typed stages/codes and normalizers
  outcome.ts               # task terminal outcome construction
  observer.ts              # request-end collection only
  classifier.ts            # deterministic precedence and confidence
  fingerprint.ts           # lineage and versioned evidence hashing
  redaction.ts             # bounded source/result redaction
  store.ts                 # file-backed journal and atomic snapshots
  audit.ts                 # lifecycle events and rebuild
```

Stage 1.5:

```txt
src/alfred-2/toolkits/
  operation-keys.ts         # versioned canonical operation vocabulary
  capability-matcher.ts     # matched/no_match/unknown semantic scope matcher

src/alfred-2/capabilities/
  eligibility.ts            # recurrence, cooldown, suppression, success guard
  reclassify.ts             # append-only reclassification under new registry versions
```

Stage 2:

```txt
src/alfred-2/capabilities/generator/
  context.ts               # deterministic context manifest builder
  contract.ts              # strict generator input/output schema
  provider.ts              # one concrete LLM adapter, no generic marketplace
  jobs.ts                  # explicit bounded jobs and stale-lease handling

src/alfred-2/capabilities/proposals/
  types.ts
  schema.ts
  state-machine.ts         # separate proposal-family and bounded-job transitions
  store.ts                 # immutable revisions and hashes
  declarative-adapters.ts  # allowed adapter descriptors
```

Stage 3:

```txt
src/alfred-2/capabilities/validation/
  pipeline.ts
  intake.ts
  static-policy.ts
  dependencies.ts
  risk-inference.ts
  compiler.ts
  fixtures.ts
  sandbox.ts
  report.ts
  repair.ts
```

Stage 4:

```txt
src/alfred-2/capabilities/adoption/
  decisions.ts             # decisions only; no installer
  reconcile.ts             # links normal repository adoption references

src/alfred-2/capabilities/notifications.ts
src/alfred-2/api/capabilities.ts
```

Tests:

```txt
test/alfred2-capability-outcomes.test.ts
test/alfred2-capability-classifier.test.ts
test/alfred2-capability-fingerprint.test.ts
test/alfred2-capability-store.test.ts
test/alfred2-capability-eligibility.test.ts
test/alfred2-capability-proposal-state.test.ts
test/alfred2-capability-generator-context.test.ts
test/alfred2-capability-validation.test.ts
test/alfred2-capability-sandbox.test.ts
test/alfred2-capability-api.test.ts
test/alfred2-capability-proactive.test.ts
```

Future toolkit integration:

```txt
src/alfred-2/toolkits/
  registry.ts
  types.ts
  ...
```

Do not create a generic scheduler for Stage 1. If Stage 5 background work is approved, introduce a small durable job runner then, separate from `server.ts` and separate from proactive cooldown state.

---

## 13. Phased implementation order and “done when” criteria

### Phase SR-0 — Outcome contract prerequisite

Scope:

- add typed tool failure details and terminal `TaskOutcome`;
- add one `/ask` request-boundary finalizer that covers validation, deterministic routes, tool-loop completion, and exceptions, producing exactly one terminal outcome per accepted request;
- instrument parser, policy, ambiguity, budget, configuration, provider, timeout, and invariant paths;
- operation/lineage arrays remain empty unless a canonical key is established deterministically;
- preserve current API compatibility;
- no persistence, proposal, LLM, UI, or notification yet.

Done when:

- every deterministic noncompletion path, including routes that return before `runToolLoop()`, has a typed stage/code;
- every accepted request is finalized exactly once;
- successful recovery results in `completed` and does not emit a gap;
- the complete current suite remains green, with baseline commit and observed count recorded at phase start;
- tests prove unknown tool, missing config, ambiguity, policy block, timeout, rate limit, transient error, and max rounds are distinct.

### Phase SR-1 — Observation and gap journal MVP

Scope:

- redaction, immutable outcome/observation journal, deterministic non-gap category classification, lineage/evidence fingerprints, basic aggregation, corrections, and local storage;
- a minimal outcome index records lineage success/failure without turning successes into gaps;
- read-only API/CLI inspection; manual correction uses a local CLI initially or a Host/Origin/CSRF-protected API;
- feature flag defaults off during initial soak;
- no proposal eligibility engine, generation cooldowns, proposal-family transitions, code generation, or notifications;
- with the current flat registry, automatic `missing_capability` classification remains disabled; explicit user classification creates only a tentative gap.

Done when:

- all provenance requirements are present;
- retries are grouped within one request;
- restart persistence and corrupt-line recovery work;
- manual corrections and basic store-only suppression work;
- storage permissions/path/link checks pass;
- any HTTP mutation used for correction passes loopback Host, same-origin, and CSRF/session-token tests;
- a labeled audit set reports per-category confusion counts and at least 90% macro accuracy for deterministic non-gap categories, with at least 10 independently reviewed fixtures in each of configuration, policy, ambiguity, timeout/rate limit, transient failure, parser/plan failure, misuse, bug, and unclassified categories;
- because automatic `missing_capability` remains disabled in SR-1, its precision is not claimed or used as an SR-2 gate until SR-1.5 runs a separate labeled audit containing confirmed real gaps and hard negative exclusions;
- no raw secrets appear in red-team fixtures, persisted digests, or API snapshots.

### Phase SR-1.5 — Semantic matching and eligibility prerequisite

Entry gate:

- standalone toolkit registry work is stable enough to own canonical operation keys and semantic descriptors;
- SR-1 persistence and correction behavior passes its soak.

Scope:

- add versioned canonical operation keys and semantic capability/scope descriptors to the authoritative toolkit registry;
- implement a deterministic matcher returning `matched`, `no_match`, or `unknown` with recorded registry/availability snapshots;
- reclassify eligible historical `unclassified` and `user_reported_gap` records without overwriting original classification events;
- implement recurrence since last success/availability change, success guards, cooldowns, suppressions, and proposal-family eligibility;
- no generation, proposal job, or notification yet.

Done when:

- fixture-based matcher parity tests cover supported, configurable, disabled, scope-mismatched, unsupported, true-gap, and unknown cases;
- success outcomes carry canonical lineage only when deterministically established;
- a labeled audit includes at least 20 independently confirmed real gaps and at least 100 hard negatives, including at least 10 examples from each excluded category, and reports missing-capability precision and recall separately;
- missing-capability precision is at least 90%, recall is reported without using it to weaken the fail-closed threshold, and zero configuration, policy, ambiguity, timeout, transient, parser, or existing-tool outcomes are promoted;
- stale failures before the most recent success or availability change never count toward recurrence;
- user-reported gaps remain ineligible unless the matcher returns `no_match`.

This phase owns the semantic matcher dependency. If standalone Phase 8 has not added these fields, SR-1.5 extends that registry contract explicitly rather than assuming another roadmap supplies it.

### Phase SR-2 — Explicit declarative proposal generation

Entry gate:

- SR-1 and SR-1.5 quality criteria pass;
- semantic capability descriptors and deterministic matching exist for the relevant toolkit subset;
- lineage-key recurrence, success guards, cooldowns, suppressions, and proposal-family eligibility are implemented and tested;
- same-origin/Host/CSRF controls protect mutating capability APIs;
- user explicitly enables proposal generation;
- declarative adapter contract is approved;
- local-only adapters are the default first slice; HTTP adapters remain disabled unless the normative trusted-client, runtime data-classification, per-invocation disclosure, and revision-bound grant contracts are implemented and tested.

Scope:

- explicit API/CLI command only;
- strict context manifest and LLM output schema;
- read-only declarative proposals only;
- immutable revision storage;
- no background generation and no TypeScript proposals.

Done when:

- generator has no shell, model-controlled network, or filesystem tools;
- remote-provider data classes, retention posture, and per-job user consent are recorded;
- context budgets and exclusions are tested;
- hostile declarative parsing/compilation beyond the minimal intake prefilter runs in a disposable worker without host or store-write access;
- proposals cannot collide with live tool names or escape storage;
- malformed/prompt-injected outputs fail closed;
- no dependency/install path exists;
- generated artifacts remain inert and unreferenced by build/runtime module resolution.

### Phase SR-3 — Validation and bounded repair

Scope:

- deterministic validation pipeline;
- trusted adapter compiler and independent fixtures;
- validation artifacts/logs;
- at most two repair revisions;
- exact evidence language.

Done when:

- all required gates are deterministic and versioned;
- author tests are visibly separate from independent evidence;
- permission/risk derivation cannot be downgraded by a proposal;
- hash changes invalidate prior validation;
- skipped required gates prevent readiness;
- repair budget, repeated-error stop, and policy-widening stop work;
- adversarial proposal corpus passes fail-closed tests;
- UI/API cannot claim “passed” without the complete evidence contract.

### Phase SR-4 — Dashboard review and adoption decisions

Entry gate:

- React dashboard/event foundation exists;
- SR-3 has produced inspectable artifacts;
- future toolkit registry contract is stable enough to define adoption targets.

Scope:

- gaps/proposals dashboard tabs;
- revision diff and validation matrix;
- accept/reject/defer/correct/delete decisions;
- proactive review queue;
- adoption references to normal reviewed repository changes;
- no installer.

Done when:

- acceptance changes no source, registry, runtime, or enabled tools;
- all decisions and proposal review grants bind to proposal revision/hash and confer no runtime authority;
- runtime capability grants are created only by the normal toolkit permission flow and bind to the actual stable tool ID, registry descriptor hash, and implementation commit;
- acceptance requires a current validation-freshness tuple covering policy, validator, adapter, registry, fixture suite, sandbox backend, and required controls;
- policy/adapter/registry/fixture/sandbox changes return stale proposals to `draft` for revalidation;
- notification cooldowns and mute/meeting policy are honored;
- review clearly states tested and untested claims;
- adopted state requires a real normal toolkit ID plus repository/commit reference.

### Phase SR-5 — Optional background generation

Entry gate:

- explicit generation has at least 10 user-reviewed proposals;
- classification precision remains at least 90%;
- no false-ready result in the maintained adversarial corpus;
- dismissal/defer behavior has no known leaks;
- user explicitly opts in;
- cost and daily quotas are configured;
- the toolkit registry and dashboard review flow are live.

Scope:

- durable, bounded background jobs;
- declarative read-only proposals only at first;
- no automatic validation claim, adoption, installation, registration, or execution;
- digest-first notifications.

Done when:

- recurrence gates are enforced across restart;
- leases prevent duplicate jobs;
- one proposal family per lineage key;
- failures use bounded backoff and never spin;
- daily generation and notification quotas hold;
- disabling background mode cancels future jobs without deleting evidence;
- all generated outputs still require the same validation and user review.

### Phase SR-X — Arbitrary code research, not committed roadmap

Consider only if declarative adapters are demonstrably inadequate and a separately reviewed isolation backend exists.

Done when, before any code proposal can be ready:

- sandbox backend enforcement is independently tested on the target macOS setup;
- no fallback to local Node execution exists;
- dependency allowlist, AST/module checks, resource limits, and no-network/no-process controls are verified;
- a security review approves the boundary;
- the user separately opts into code-bearing proposals.

---

## 14. Test strategy

### 14.1 Classification table tests

For every category, test positive and exclusion cases:

- missing capability versus unknown hallucinated tool;
- missing capability versus disabled/misconfigured existing tool;
- misuse versus tool bug;
- transient 5xx versus stable 4xx;
- timeout versus context handoff;
- ambiguity versus target not found;
- policy block versus unsupported product boundary;
- task recovery versus terminal failure.

Use table-driven fixtures and assert classification, confidence ceiling, rationale codes, and proposal eligibility.

### 14.2 Fingerprint/property tests

- timestamps, IDs, paths, workspace names, and redacted task wording do not change the fingerprint;
- operation, target class, risk, detector version, or registry schema changes do;
- stable canonical JSON independent of key insertion order;
- retries in one request dedupe;
- distinct requests aggregate;
- fuzz Unicode/confusables and oversized inputs.

### 14.3 Store and recovery tests

- atomic write and snapshot rebuild;
- concurrent append serialization;
- only a truncated final observation append may be ignored;
- malformed interior lines or authoritative journal/hash-chain corruption force read-only quarantine and block side effects;
- deleted excerpt blobs cannot be recovered from journals, snapshots, or persistent raw-content hashes;
- staging directory crash recovery;
- stale lease becomes failed;
- hash mismatch quarantines;
- symlink/hardlink/path traversal rejected;
- permissions are 0700/0600/0444 as designed;
- retention removes excerpts but keeps minimal provenance/tombstones.

### 14.4 Eligibility and lifecycle tests

- exact recurrence windows and distinct-request/session counting;
- no success-after-failure promotion;
- suppression precedence;
- reject/defer/reopen/resolution guards;
- one active family per lineage key;
- invalid transition is a typed conflict and writes nothing;
- validation/acceptance invalidated by byte change;
- repair limits and repeated-error stop;
- accepted state performs no integration side effects.

### 14.5 Generator-context tests

- only allowlisted files included;
- byte/token/file budgets enforced;
- secrets, `.env`, credentials, home paths, private content, pending confirmations, and unrelated memory excluded;
- prompt-injection strings remain delimited as data;
- no model tool access;
- strict output file map, no path escape or links;
- output and context manifests hash correctly.

### 14.6 Validation tests

- unknown/duplicate manifest keys;
- confusable/reserved names;
- schema bombs and deep/large structures;
- risk downgrade attempts;
- unsupported adapter/permissions/origins;
- author tests pass while independent fixture fails;
- required gate skipped;
- stale validator/policy/adapter versions;
- content changes during validation;
- malformed logs and output flooding;
- no proposal-supplied command/config/script executed.

### 14.7 Security adversarial corpus

Include:

- prompt injection asking for secrets or registry changes;
- `child_process`, shell, eval, dynamic imports, native addons, process/env access;
- dependency `postinstall` and package-manager config;
- Keychain, `osascript`, `launchctl`, Python/Perl/Node command escape;
- symlink/hardlink/traversal/device/socket paths;
- SSRF to loopback, RFC1918, link-local, metadata addresses, encoded/mapped IP forms, DNS rebinding, second unvalidated lookups, and redirect bypass;
- indirect sensitive-value propagation and proposal-authored data-class labels;
- fork/CPU/memory/output/hanging-socket attempts;
- forged validation artifacts, approval replay, and hash substitution;
- cross-origin form/fetch requests, missing or forged `Origin`, DNS-rebinding `Host`, and stale/missing CSRF/session tokens;
- allowed-origin exfiltration through path/query interpolation, redirects, or fields mislabeled non-sensitive;
- `autoConfirm` and boolean-confirm attempts on explicit actions;
- corrupted state and incomplete adoption references.

### 14.8 API/event/UX tests

- list APIs exclude raw excerpts by default;
- artifact endpoint cannot traverse paths;
- stale revision/hash or validation-freshness decisions conflict;
- permission/origin/root/egress grants bind to exact revision/hash;
- no capability route or process handle can mutate source, registry, runtime, or enabled tools;
- no install/enable/register/execute route exists as defense in depth;
- SSE events contain only sanitized IDs/status;
- hydration returns counts only;
- notification dedupe, daily quotas, mute, meeting, microphone, defer, and suppression;
- deterministic notification wording includes “not installed” and residual limitations.

### 14.9 Regression validation

Every phase runs:

```txt
pnpm run typecheck
pnpm test
```

Add focused capability tests and preserve existing tool-loop, parser, risk/confirmation, proactive, server, file, web, Google, and integration tests.

For later adoption, proposal validation is not a substitute for the normal repository test suite and independent code review.

---

## 15. Open decisions, with recommended answers

| Decision | Recommended answer | Needed for MVP? |
|---|---|---:|
| Product name | User-facing “Capability Lab” or “Capability Proposals”; keep “self-renewing” as vision, not a safety claim. | No blocker. |
| Observation classifier | Deterministic rules only for eligibility; LLM annotations advisory. | Yes. |
| Gap recurrence | Three distinct requests across two days/sessions in 30 days, counted only after the latest success/availability change; explicit user generation may waive recurrence but not deterministic semantic matching. | Yes. |
| Confidence aggregation | Minimum qualifying confidence, never average. | Yes. |
| Proposal target | Declarative read-only adapters first; arbitrary TypeScript disabled. | Yes. |
| Workflow compositions | Do not generate a tool when existing tools suffice; fix planner/tool-use behavior instead. | Yes. |
| Dependencies | Empty set in MVP; later exact pre-vendored allowlist only. | Yes. |
| Proposal storage | `~/.alfred/capabilities/`, outside repositories and import/watch roots. | Yes. |
| Persistence backend | JSONL journals plus atomic JSON snapshots; avoid a new database until real query/concurrency pressure appears. | Yes. |
| Raw task retention | Store bounded canonical-redacted excerpts in separately deletable blobs for 30 days by default; journals retain no raw-content hash. | User may later tune. |
| Generator repository access | Preassembled allowlisted context only; no browsing tool in MVP. | Yes. |
| Repair budget | One format repair plus at most two semantic revisions. | Yes. |
| Background generation | Off by default; opt-in only after measured gates. | Later. |
| Proactive speech | Off by default; dashboard plus at most one daily notification. | User preference later. |
| Adoption automation | Acceptance records intent only. A separate normal development workflow prepares any code change. | Yes. |
| Runtime registration | Normal toolkit registry at startup/restart only; never scan proposals. | Yes. |
| Future code sandbox | No default yet. Evaluate VM/container or dedicated low-privilege broker; fail closed if unavailable. | Not for MVP. |
| Network adapter | Default first slice is local-only. HTTP requires the normative pinned-address client, platform-owned runtime data classes, revision-bound grants, and explicit per-invocation disclosure for unknown/user/private-derived values. | Only if included in a later adapter set. |
| Mutation proposals | Defer. When introduced, local mutations require confirm; network mutations/destructive operations require explicit. | No. |
| Same-user tampering | Document as out of scope for strong protection; use hashes/permissions for drift and accidents. | Yes, as limitation. |

No unresolved decision blocks the observation MVP. Before SR-2, the user should approve the initial declarative adapter set and task-retention preference. Before SR-5, the user must choose whether background generation and speech notifications are worth enabling. Before any SR-X work, a sandbox backend requires a separate architecture/security decision.

---

## 16. Explicit ways this could go wrong

1. **False capability gaps:** Alfred turns planner mistakes, config problems, or outages into useless tools.
2. **Feedback loop:** a hallucinated tool name becomes a generated proposal that reinforces the hallucination.
3. **Proposal spam:** recurrence is counted by attempts instead of distinct user requests.
4. **Wrong dedupe:** similar wording merges unrelated needs, or dynamic IDs split one recurring gap.
5. **Low-value automation:** Alfred spends tokens generating capabilities the user never wanted.
6. **Circular validation:** the same model writes implementation and expected answers, then declares success.
7. **Evidence overclaim:** “typecheck and tests passed” is presented as “safe and correct.”
8. **Prompt injection:** source tasks or external tool output instruct the generator to leak secrets or widen scope.
9. **Secret persistence:** raw credentials enter observations, prompts, generated source, logs, or notifications.
10. **Registry escape:** a proposal directory becomes an import root, watcher target, or startup scan path.
11. **Shell escape:** generated code uses a wrapper or obscure command to evade regex risk classification.
12. **Risk downgrade:** a proposal labels a network mutation as a read.
13. **Sandbox fiction:** Node timeout/output limits are mistaken for filesystem/network/process isolation.
14. **Symlink/TOCTOU escape:** validated bytes or paths change before review/adoption.
15. **SSRF:** a read-only adapter reaches localhost, private networks, metadata endpoints, or credential-bearing redirects.
16. **Dependency compromise:** generated package metadata triggers install scripts, native addons, or poisoned transitive code.
17. **Validator compromise:** the validator runs proposal-supplied commands, configs, loaders, or test scripts.
18. **Notification coercion:** a friendly “I fixed myself” message pressures the user to accept without reviewing permissions.
19. **Dismissal leakage:** rejected/deferred proposals keep resurfacing after restart or detector changes.
20. **Background runaway:** provider failures or corrupt jobs trigger repeated costly generation.
21. **State corruption:** partial writes create duplicate jobs or lose provenance.
22. **Adoption ambiguity:** `accepted` is interpreted as installed or active.
23. **Stale validation:** API, adapter, policy, or registry versions change after the proposal passed.
24. **Existing bug duplication:** Alfred generates a replacement instead of fixing the actual tool.
25. **Policy circumvention:** a policy-blocked request is reframed as a missing capability.
26. **cmux coupling:** generated capabilities assume cmux workspace concepts and weaken standalone architecture.
27. **Marketplace drift:** schemas become generic packaging/distribution infrastructure with no local user value.
28. **Roadmap derailment:** capability work consumes the React/event/voice milestone and leaves the primary product unfinished.
29. **Maintenance burden:** accepted generated tools become undocumented one-off code that nobody owns.
30. **Local attacker limitation:** another process running as the same user can alter files despite application-level controls.
31. **Localhost request forgery:** a malicious webpage or DNS-rebinding host forges “explicit user” generation, validation, or acceptance actions.
32. **Allowed-origin disclosure:** a fixed public origin receives sensitive user input through an apparently read-only query or path.

The architecture should optimize for detecting these failures early, not for maximizing proposal throughput.

---

## 17. Relationship to the standalone-product roadmap

### 17.1 Alignment

This system is additive to the standalone vision:

- local-first, one user/machine;
- cmux is one adapter, not the capability identity;
- provenance is captured at write time, consistent with the memory roadmap;
- proposal notifications reuse the single proactive/Work Radar attention path;
- accepted capabilities ultimately enter the planned toolkit registry with risk folded in;
- dashboard review belongs in the React app, not the inline `dashboard.ts` string;
- no generic provider or marketplace abstraction is introduced.

### 17.2 Scheduling against standalone phases

| Standalone roadmap point | Self-renewing work |
|---|---|
| Phase 0 inventory | This roadmap extends inventory with 19-tool count and renewal-specific safety/integration findings. |
| Phase 1 React shell | Do not delay it. No proposal UI in the old inline dashboard. |
| Phase 2 event bus + browser voice | Finish the first meaningful standalone milestone before capability generation work. Request/event correlation will benefit gap provenance. |
| Phase 3 live events | After this stabilizes, SR-0 structured outcomes may begin as a bounded reusable prerequisite. Do not insert the full SR-1 track into the critical path. |
| Phase 4 memory taxonomy | Reuse provenance principles, but do not store capability jobs in profile/session memory. SR-1 may run only as separately budgeted non-critical work after this taxonomy is stable. |
| Phases 5-6 knowledge/memory | No hard dependency. Generator context must not automatically ingest these stores. |
| Phase 7 Work Radar | Show gap/proposal attention through the same signal computation and proactive event path. Do not create a second radar. |
| Phase 8 toolkit registry | The registry becomes authoritative for capability matching, availability, risk, and accepted tools. SR-1.5 explicitly adds the versioned operation keys, semantic descriptors, deterministic matcher, and parity tests if Phase 8 does not already contain them. |
| Phase 9 visual identity | Proposal UI follows the chosen app identity; no effect on core safety. |

### 17.3 Recommended calendar order

1. Complete standalone React/event/browser-voice first meaningful milestone.
2. Stabilize event correlation and hydration.
3. Implement only SR-0 structured outcomes as a bounded reusable prerequisite.
4. Continue the standalone memory taxonomy and primary roadmap; SR-1 may run only in separately budgeted non-critical capacity after the taxonomy is stable.
5. Complete Work Radar and the toolkit registry's core capability/risk descriptors.
6. Run SR-1.5 to add/verify canonical operation keys, deterministic semantic matching, eligibility guards, and the missing-capability quality audit.
7. If the evidence shows real recurring missing capabilities, implement SR-2 and SR-3 for local declarative read-only proposals; keep HTTP disabled until its additional contracts pass.
8. Add the SR-4 dashboard review surface when the React Tools/Capabilities page and proactive event stream are ready.
9. Consider SR-5 background generation only after explicit-generation evidence meets the gates.
10. Treat arbitrary generated code as a separate security project, not an incremental toggle.

### 17.4 First implementation task

When implementation is authorized, the first task should be:

> Define a versioned `TaskOutcome` and `StructuredFailure` contract, then add one `/ask` request-boundary finalizer and instrument both pre-tool-loop and tool-loop terminal paths without adding persistence or generation.

This produces the evidence foundation needed to distinguish a missing capability from every other failure class. Starting with an LLM generator would build the most expensive and dangerous part before Alfred can identify what problem it is solving.

### 17.5 Final go/no-go rule

Proceed beyond logging only if real observations demonstrate that:

- missing capabilities recur;
- deterministic classification is precise;
- the proposed declarative adapter set can address them;
- users find explicit proposals useful;
- validation catches seeded unsafe/incorrect proposals;
- the work does not displace the standalone product's primary milestones.

If the SR-1.5 audit shows that most observations are planner errors, missing credentials, timeouts, or existing-tool bugs, stop this roadmap after SR-1.5 and invest in those systems instead.
