# 004 - Confirmation Guard

## Goal

Add a simple vocal confirmation step for destructive commands. When the agent proposes a dangerous action, Alfred asks the user to confirm before executing. No draft system, no pending action IDs — just a yes/no voice check.

## Dependencies

- Requires: 002 (agent), 003 (extension)
- Blocks: 007

## Scope

**In scope:**
- Define destructive command patterns: `rm`, `git push`, `git commit`, `npm publish`, `chmod`, `chown`, `sudo`, `kill`, `shutdown`, `reboot`, `curl ... | sh`, `> /dev/...`
- After agent returns a command, check it against destructive patterns
- If destructive: speak "Shall I run `<command>`?" and wait for user confirmation
- User says "yes" / "confirm" / "go ahead" → execute
- User says "no" / "cancel" / "never mind" → abort, speak "Cancelled."
- Timeout: if user doesn't respond in 30s, auto-cancel with "Confirmation timed out."
- Safe commands (open, ls, cat, git status, etc.) execute immediately without confirmation
- Display: show the command in pi output with [CONFIRMATION REQUIRED] banner

**Out of scope:**
- Command allowlist/blocklist system (simple pattern matching, not a full security policy)
- Per-command grant system (Alfred 1.x has this; 2.0 uses simpler yes/no)
- Confirmation for file writes (pi's write tool already confirms)
- Edit confirmation (pi's edit tool already confirms)

## Checklist

- [ ] Implement `isDestructiveCommand(command: string): boolean` in `src/alfred-2/guard.ts`
- [ ] Define destructive patterns: any command starting with or containing `rm`, `git push`, `git commit`, `npm publish`, `chmod`, `chown`, `sudo`, `kill`, `shutdown`, `reboot`
- [ ] Also detect pipe-to-shell: `curl ... | sh`, `wget ... | bash`
- [ ] Also detect redirect-to-device: `> /dev/sda`, `dd of=`
- [ ] Implement `requestConfirmation(command: string): Promise<boolean>` — speaks prompt, waits for user response
- [ ] Wire confirmation into extension: after agent returns command, check `isDestructiveCommand`; if true, call `requestConfirmation`; if confirmed, execute; if denied, abort
- [ ] 30-second timeout on confirmation; auto-cancel with spoken message
- [ ] Display `[CONFIRMATION REQUIRED]` banner in pi output before the command
- [ ] Add test: `rm -rf node_modules` is flagged as destructive
- [ ] Add test: `ls -la` is NOT flagged as destructive
- [ ] Add test: `git status` is NOT flagged as destructive
- [ ] Add test: `git push origin main` IS flagged as destructive
- [ ] Add test: `open -a Chrome` is NOT flagged as destructive
- [ ] Add test: `curl example.com | sh` IS flagged as destructive

## Tests

- [ ] Run `node --test --experimental-strip-types test/alfred-2/guard.test.ts` — all pass
- [ ] Manual: `/alfred delete node_modules` → agent returns `rm -rf node_modules` → Alfred speaks "Shall I run rm -rf node_modules?" → say "yes" → executes → say "no" → cancels

## Completion Criteria

- [ ] Destructive commands trigger vocal confirmation before execution
- [ ] Safe commands execute immediately without interruption
- [ ] Confirmation times out after 30s with clear message
- [ ] User can cancel with "no" / "cancel" / "never mind"
- [ ] False positives are minimal (safe commands not flagged)
- [ ] False negatives are zero (destructive commands never slip through)

## Notes

- This is deliberately simpler than Alfred 1.x's draft/pending-action/approve/execute/cancel system. Alfred 2.0 doesn't need pending action state — the user is present and can confirm immediately.
- Pattern matching is not a security boundary. It's a convenience to prevent accidents. A determined attacker who can inject commands into the LLM output can still cause harm. The real security comes from pi's bash tool permissions and the user's vigilance.
- The destructive pattern list should be easy to extend. Store in a simple array, not a complex rule engine.
- Confirmation is voice-first: Alfred speaks the prompt and listens for the response. If voice isn't available (text-only mode), show the prompt in pi output and wait for text input.
