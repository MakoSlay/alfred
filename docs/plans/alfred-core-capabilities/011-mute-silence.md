# 011 - Mute & Silence

## Goal

Add a timed mute to Alfred that suppresses all speech output and proactive notifications for a configurable duration, so the user can silence Alfred during meetings without stopping the daemon. Deterministic commands still return text silently; only speech and watcher pushes are suppressed.

## Dependencies

- Requires: None (depends only on existing daemon infrastructure)
- Blocks: None

## Scope

**In scope:**
- `POST /mute` daemon endpoint: accepts `{ durationMs: number }` (e.g., 1800000 for 30 min), sets `mutedUntil` on daemon state
- `POST /unmute` endpoint: clears `mutedUntil` immediately
- `GET /mute/status` endpoint: returns `{ muted: boolean, mutedUntil: IsoTimestamp | null, remainingMs: number | null }`
- Mute guard in `handleRequest`: if `mutedUntil` is in the future, strip `speech` from `AlfredHandleResponse` and suppress all watcher/notification pushes
- Text responses still work silently — the user can still query `"what targets are active"` and see the answer as text in Pi
- Auto-expiry: on any request, check if `mutedUntil` has passed and auto-clear
- Deterministic router: `"mute for 30 minutes"`, `"mute for 1 hour"`, `"silence for 5 minutes"`, `"shut up for 30 minutes"`, `"unmute"`, `"are you muted"`, `"mute status"`
- Planner intents: `mute` (with duration), `unmute`, `mute_status`
- Mute state is ephemeral — clears on daemon restart (same as conversation memory)

**Out of scope:**
- Per-target mute (global only)
- Mute schedules (e.g., "mute every day 2-3pm")
- Mute with exceptions (e.g., "mute except for Powerco")
- Persisting mute across daemon restarts
- Integration with OS "Do Not Disturb" or Focus modes

## Checklist

- [ ] Add `mutedUntil: IsoTimestamp | null` to `DaemonState`
- [ ] Add `POST /mute` route: validate duration (min 1 second, max 24 hours), set `mutedUntil`, return ok with expiry time
- [ ] Add `POST /unmute` route: clear `mutedUntil`, return ok
- [ ] Add `GET /mute/status` route: return current mute state with remaining time
- [ ] Add mute guard in `handleRequest`: check `mutedUntil` at top of handler, if active strip `speech` from every response, suppress watcher event pushes, suppress draft-created notifications
- [ ] Add auto-expiry: on any request, if `now() >= mutedUntil`, set `mutedUntil = null` before processing
- [ ] Add `mute`, `unmute`, `mute_status` to `AlfredPlannerIntent` union type
- [ ] Add `mute` validation: requires `durationMs` (positive integer, max 86400000)
- [ ] Add deterministic router patterns: `"mute for <N> minutes"`, `"mute for <N> hours"`, `"silence for <N> minutes"`, `"shut up for <N> minutes"`, `"unmute"`, `"are you muted"`, `"mute status"`
- [ ] Update planner system prompt with `mute`, `unmute`, `mute_status` tool shapes
- [ ] Add planner unit tests: mute parsing and validation
- [ ] Add daemon test: `POST /mute` sets mutedUntil correctly
- [ ] Add daemon test: muted request returns ok with text but no speech field
- [ ] Add daemon test: `POST /unmute` clears mutedUntil
- [ ] Add daemon test: `GET /mute/status` returns correct remaining time
- [ ] Add daemon test: mute auto-expires after duration passes
- [ ] Add daemon test: deterministic `"mute for 30 minutes"` sets mute
- [ ] Add daemon test: deterministic `"unmute"` clears mute
- [ ] Add daemon test: deterministic `"are you muted"` returns mute status
- [ ] Add daemon test: during mute, `"what targets are active"` still returns text (no crash, no hang)

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass including mute tests
- [ ] Run `node --test --experimental-strip-types test/router.test.ts` — all pass
- [ ] Run `npm run check` — zero regressions
- [ ] Manual smoke: `curl -X POST http://127.0.0.1:47321/mute -H 'x-alfred-auth: ...' -d '{"durationMs": 60000}'` → verify `/mute/status` shows muted, then `/unmute` clears it

## Completion Criteria

- [ ] `/alfred mute for 30 minutes` silences Alfred; speech and proactive pushes stop
- [ ] `/alfred unmute` restores normal behavior immediately
- [ ] `/alfred are you muted` reports current mute state and remaining time
- [ ] During mute, queries still work — text responses return but without speech
- [ ] Mute auto-expires after the requested duration
- [ ] Mute clears on daemon restart (no stale state)
- [ ] All existing tests pass

## Notes

- Mute is purely defensive — it never blocks anything, only suppresses output. This means it's safe (no confirmation needed).
- The Pi bridge (`pi-smart-voice-notify`) already respects the `speech` field on responses. When `speech` is absent, Pi won't speak. So stripping `speech` from muted responses is sufficient to silence Alfred in Pi.
- Watcher pushes (sidebar log entries, notifications) should also be suppressed during mute. The watcher poll loop should check `mutedUntil` before pushing.
- Duration parsing for deterministic router: support `"N minutes"`, `"N hours"`, `"N seconds"`. Convert to milliseconds. Reject durations over 24 hours.
- The mute endpoint is authenticated (requires `x-alfred-auth` header, same as all other daemon routes). The dashboard could expose a mute button that calls this endpoint.
