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

- [ ] Read Pi loop ownership code in `src/index.ts` (`startDelegationLoop`, `scheduleDelegationLoopPoll`, `stopDelegationLoop`) and identify daemon-portable concepts.
- [ ] Define loop contracts for start/stop/status, target refs, poll cadence, stop conditions, and allowed capabilities.
- [ ] Add daemon loop manager module with explicit lifecycle state and no hidden global sends.
- [ ] Expose minimal daemon API/control path for loop start/stop/status for future clients and dashboard visibility.
- [ ] Implement the concrete `loop.autonomousSend` approval capability before any loop send can bypass draft confirmation.
- [ ] Ensure loop sends use draft-confirm unless the explicit loop-send approval model is present and tested.
- [ ] Add tests for start, poll scheduling seam, stop, target disappearance, send failure, capability denial, and missing autonomous-send approval.
- [ ] Document the Pi bridge migration outline and rollback requirements for task 013 without modifying Pi behavior here.

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

- [ ] Daemon owns loop lifecycle state and emits loop lifecycle events.
- [ ] Loop sends/observations are capability-scoped and fail closed.
- [ ] Any autonomous loop send requires a concrete approval capability/model; otherwise it must require draft confirmation.
- [ ] Loops can be stopped reliably from daemon API.
- [ ] Pi behavior is unchanged by this task.
- [ ] Standalone Alfred gates pass.

## Notes

- This task should not pretend loop extraction is complete; task 013 covers making Pi a loop client in daemon mode.
- Prefer explicit timer seams in tests so loop behavior does not depend on wall-clock sleeps.
- Loop planning may use Task 009's planner, but loop lifecycle/state must remain testable without a live provider.

## Blockers

_None currently; dependencies are captured above._
