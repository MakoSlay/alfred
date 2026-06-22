# 010 - Daemon-Owned Loop Manager Foundation

## Goal

Define Alfred daemon loop contracts and an in-daemon loop manager foundation while keeping loop actions capability-scoped, stoppable, and observable.

## Dependencies

- Requires: 008, 009
- Blocks: 013
- Related: 011 for persisted loop state and 012 for loop status display

## Scope

Define and implement the daemon-side loop manager foundation by adapting concepts from the current Pi extension loop code. Do not bundle the Pi bridge migration into this task; that is handled by task 013.

**In scope:**

- Loop state/contracts in daemon-owned runtime modules.
- Start, poll, stop, and status behavior for one active loop foundation.
- Capability checks for any loop-originated sends or observations.
- Events/history for loop lifecycle transitions.
- A documented migration path outline for task 013, without changing Pi behavior in this task.

**Out of scope:**

- Multi-user/cloud scheduling.
- Persistence beyond the storage decision in task 011.
- Changing Pi loop ownership or removing Pi-local loop code before daemon loop behavior has live confidence.
- Voice-specific loop UX.

## Interface Sketch

Task 010 should implement a daemon-owned loop manager close to this shape:

```ts
export interface AlfredLoopStartRequest {
  requestId: AlfredId;
  source: AlfredSource;
  targetRef: AlfredRef;
  goal: RedactedText;
  maxTurns: number;
  pollIntervalMs: number;
  allowedCapabilities: AlfredCapability[];
}

export type AlfredLoopDecision =
  | { kind: "wait"; reason?: string }
  | { kind: "draft_reply"; message: string }
  | { kind: "done"; summary: string }
  | { kind: "needs_user"; summary: string };

export interface AlfredLoopManager {
  start(request: AlfredLoopStartRequest): Promise<AlfredHandleResponse>;
  poll(loopId: AlfredId): Promise<AlfredLoopDecision>;
  stop(loopId: AlfredId, options?: { interruptTarget?: boolean }): Promise<AlfredHandleResponse>;
  status(loopId?: AlfredId): AlfredLoopSummary | null;
}
```

Autonomous-send approval model for the first pass:

- Add/use a distinct privileged capability named `loop.autonomousSend`.
- If the loop source lacks `loop.autonomousSend`, every loop-originated reply must create a pending draft and wait for confirmation.
- `loop.manage` can start/stop/status loops, but it does not imply autonomous sending.
- Per-loop approval tokens are out of scope for Task 010 unless the task file is explicitly revised before implementation.

## Checklist

- [x] Read Pi loop ownership code in `src/index.ts` (`startDelegationLoop`, `scheduleDelegationLoopPoll`, `stopDelegationLoop`) and identify daemon-portable concepts.
- [x] Define loop contracts for start/stop/status, target refs, poll cadence, stop conditions, and allowed capabilities.
- [x] Add daemon loop manager module with explicit lifecycle state and no hidden global sends.
- [x] Expose minimal daemon API/control path for loop start/stop/status for future clients and dashboard visibility.
- [x] Implement the concrete `loop.autonomousSend` approval capability before any loop send can bypass draft confirmation.
- [x] Ensure loop sends use draft-confirm unless the explicit loop-send approval model is present and tested.
- [x] Add tests for start, poll scheduling seam, stop, target disappearance, send failure, capability denial, and missing autonomous-send approval.
- [x] Document the Pi bridge migration outline and rollback requirements for task 013 without modifying Pi behavior here.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

Pi bridge/control paths should not be touched in this task. If that scope changes, split the Pi changes into task 013 and run:

```bash
cd /Users/muhammadabdul/work/pi-smart-voice-notify
npm run check
npm run typecheck
npm test
```

Manual smoke after daemon loop support exists:

```text
/alfred can you ask my power co session in this workspace to let me know what files i can delete now?
/alfred stop
```

## Completion Criteria

- [x] Daemon owns loop lifecycle state and emits loop lifecycle events.
- [x] Loop sends/observations are capability-scoped and fail closed.
- [x] Any autonomous loop send requires a concrete approval capability/model; otherwise it must require draft confirmation.
- [x] Loops can be stopped reliably from daemon API.
- [x] Pi behavior is unchanged by this task.
- [x] Standalone Alfred gates pass.

## Notes

- This task should not pretend loop extraction is complete; task 013 covers making Pi a loop client in daemon mode.
- Prefer explicit timer seams in tests so loop behavior does not depend on wall-clock sleeps.
- Loop planning may use Task 009's planner, but loop lifecycle/state must remain testable without a live provider.

## Implementation Notes

- Added `src/loops/index.ts` with daemon-owned loop contracts, one-active-loop lifecycle state, target resolution, observation capability checks, a decision seam, and an explicit scheduler seam.
- Added daemon loop control routes: `POST /loops/start`, `POST /loops/poll`, `POST /loops/stop`, and `GET /loops/status`. `/state` now reports `activeLoop` from the daemon loop manager.
- Loop start/status/stop emit lifecycle responses/events and keep state daemon-owned. The first-pass manager observes visible cmux targets through `readSurface` and does not read raw Pi session files or transcripts by default.
- Loop `draft_reply` decisions create pending drafts unless the original loop source has the distinct `loop.autonomousSend` capability. `loop.manage` alone can start/stop/status/poll but does not permit direct sends.
- Autonomous loop replies require both the target send capability (`surface.send` or `workspace.send`) and `loop.autonomousSend`; send failures return `send_failed` and do not claim success.
- Pi extension behavior was not changed in this task.

## Task 013 Pi Bridge Migration Outline

- Keep the Pi bridge opt-in behind the existing daemon bridge flags; default Pi-local loop behavior must remain the rollback path.
- In daemon mode, Pi should translate current loop intents (`delegate_loop`, loop status, stop loop) into daemon `/loops/*` calls rather than owning `activeDelegationLoop` locally.
- If daemon `/loops/start`, `/loops/poll`, `/loops/status`, or `/loops/stop` is unavailable, unauthorized, or returns unsupported/failed responses, Pi should fall back to its existing local loop path and report the fallback reason.
- Pi should not pass raw session files to the daemon in the first migration. The daemon loop foundation observes cmux surfaces only; any session-file observation requires a separately documented privacy/retention change.
- Rollback is disabling the daemon bridge flags; the Pi-local `startDelegationLoop`, `scheduleDelegationLoopPoll`, and `stopDelegationLoop` functions remain intact until task 013 proves parity.

## Validation Evidence

- 2026-06-22: `npm run check` — passed (49 tests).
- 2026-06-22: `npm run typecheck` — passed.
- 2026-06-22: `npm test` — passed (49 tests).

## Blockers

_None currently; dependencies are captured above._
