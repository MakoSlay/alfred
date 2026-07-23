# Phase 6B Reviewed Memory Contract

## Purpose

Alfred may suggest durable Profile memories from current-session conversation text, but it must never create durable memory silently.

## Invocation and eligibility

- Extraction runs only when the user explicitly selects one or more current-session turns in the Memory page and chooses **Extract candidates**.
- The server resolves selected stable turn IDs against the current in-memory session. Client-provided text is never accepted as source material.
- The complete retained `userText` (up to the session's 1,000-character bound) is inspected before any proposal is returned. Assistant output, tool names/output, Knowledge, durable history, handoffs, Notes, files, and unselected turns are excluded. Candidate evidence is then reduced to the bounded exact supporting clause.
- Phase 6B recognizes a narrow deterministic set of explicit statements: preferred name and stable preferences. It does not ask an LLM to infer facts.
- A selected turn is excluded as a whole when it may contain a secret or sensitive fact. Exclusion responses contain only the turn ID and a generic reason.

## Candidate lifecycle

- Candidate batches exist only in server memory and browser component state. They are not written to Profile, history, handoffs, Knowledge, Notes, logs, or dashboard hydration state.
- Batches use random IDs, are bound to the server session, expire after 15 minutes, are bounded to 5 batches and 10 candidates per batch, and are invalidated when working memory is cleared.
- Responses use `Cache-Control: no-store` and the existing loopback-origin/private-memory protections.
- Every candidate exposes its proposed key, value, category, server session ID, selected stable session-record ID, original request/turn identifiers when available, timestamp, bounded filtered source text, and any existing-key conflict. Confidence semantics remain intentionally deferred.

## Review decisions

Each candidate requires an individual decision:

- **Accept**: the user may edit the key, value, or allowed category, then explicitly accept that candidate.
- **Reject**: discards only that ephemeral candidate.
- Closing, refreshing, expiry, server restart, or session clearing discards unaccepted candidates.
- Session auto-confirm is not read by these endpoints and cannot accept a candidate.

Accepted values are revalidated for key syntax, size, category, secrets, and sensitive content. Durable provenance keeps `sourceId`, `requestId`, and `turnId` tied to the original selected session record, while the typed `review` metadata records the batch ID, candidate ID, extraction request ID, server session ID, and stable session-record ID.

## Conflict and supersession policy

- Reviewed acceptance is create-only and atomically checks that the normalized key is still absent.
- An existing key is shown as a conflict. Acceptance never replaces it, even if the existing fact came from conversation rather than manual entry.
- If another writer creates the key after extraction, acceptance fails with a conflict and leaves the candidate available for editing or rejection.
- To supersede an existing fact, the user must use the existing stable-ID Profile edit flow. That update requires `expectedUpdatedAt`, preserves the stable ID, and advances the revision monotonically.
- Phase 6B does not persist rejected candidates, superseded values, or revision history. Deleting a Profile fact physically removes the current fact under the existing deletion boundary; activity history and handoffs remain separate.
