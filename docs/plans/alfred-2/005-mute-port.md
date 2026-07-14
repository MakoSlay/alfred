# 005 - Mute Port

## Goal

Port the mute feature from Alfred 1.x to Alfred 2.0. When muted, Alfred 2.0 suppresses all speech output but still processes commands and returns text silently.

## Dependencies

- Requires: 003 (extension)
- Blocks: 007

## Scope

**In scope:**
- In-memory mute state: `mutedUntil` timestamp (same as Alfred 1.x)
- `/alfred mute for 30 minutes` → sets `mutedUntil`
- `/alfred unmute` → clears `mutedUntil`
- `/alfred are you muted` → reports status and remaining time
- Mute guard: if muted, strip speech from agent response, only show text in pi output
- Auto-expiry: check `mutedUntil` on each request, auto-clear if past
- Mute state is ephemeral (clears on pi restart)
- Mute affects only Alfred 2.0, not pi itself or Alfred 1.x

**Out of scope:**
- Muting pi itself (use pi's own mechanisms)
- Syncing mute state between Alfred 1.x and 2.0 (they're independent)
- Per-workspace mute
- Scheduled mute

## Checklist

- [ ] Port `mutedUntil` state into Alfred 2.0 extension (in-memory variable)
- [ ] Handle mute/unmute/status intents in the agent pipeline: detect these before calling LLM (save tokens)
- [ ] Mute guard: before speaking agent response, check `mutedUntil`; if active, suppress speech, show "[muted]" indicator in pi output
- [ ] Auto-expiry: on each `/alfred` call, check if `mutedUntil` is past; auto-clear
- [ ] Mute/unmute/status handled without LLM call (deterministic, instant, zero tokens)
- [ ] Add test: mute suppresses speech but text still appears
- [ ] Add test: unmute restores speech
- [ ] Add test: mute auto-expires after duration
- [ ] Add test: mute status reports remaining time
- [ ] Add test: mute survives multiple `/alfred` calls until expiry

## Tests

- [ ] Run `node --test --experimental-strip-types test/alfred-2/mute.test.ts` — all pass
- [ ] Manual: `/alfred mute for 1 minute` → speak → silence. `/alfred what targets` → text only, no speech.

## Completion Criteria

- [ ] Mute silences Alfred 2.0 speech for the requested duration
- [ ] Queries still work and return text silently during mute
- [ ] Mute status reports accurate remaining time
- [ ] Unmute restores speech immediately
- [ ] Mute clears on pi restart (ephemeral)
- [ ] Mute/unmute/status are handled deterministically (no LLM cost)

## Notes

- The mute logic is nearly identical to Alfred 1.x's implementation. The main difference: Alfred 1.x has HTTP endpoints (`POST /mute`); Alfred 2.0 handles it directly in the extension.
- Mute/unmute/status should be detected by simple regex before the agent pipeline runs. No need to spend LLM tokens on "mute for 30 minutes."
- The `[muted]` indicator in pi output reminds the user that Alfred is silenced.
