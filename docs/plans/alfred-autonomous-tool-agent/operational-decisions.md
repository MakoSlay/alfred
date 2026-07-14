# Operational Decisions

## Scope / Distribution

Alfred 2.0 is a personal local assistant for Muhammad's macOS development workflow in this phase.

Out of scope for now:

- multi-user auth
- installer/distribution polish
- cross-platform support
- generic onboarding
- secret isolation for other users

## Display Surfaces

Voice is primary, but voice should stay concise.

- `speech`: short spoken result only.
- `displayText`: full detail for HTTP/API consumers.
- macOS notification: short summary/confirmation notice.
- terminal logs: developer-facing diagnostics only.
- cmux feed/sidebar/dashboard: later; not required in this phase.

When Alfred has more detail than should be spoken, put it in `displayText` and optionally a short macOS notification. Do not read long logs, diffs, CI output, or handoffs aloud.

## Web Search Provider Strategy

Use **Exa** as the initial and default web search provider, matching pi's preferred provider when available.

Initial provider scope:

1. Exa direct API via `EXA_API_KEY`

Other providers are deferred. Perplexity, Brave, Tavily, SearXNG/local, and Gemini can be added later behind the same `web_search` contract if needed.

Gemini is not part of the initial `web_search` provider because it is not a plain search API. It can be added later as a grounded-answer provider with a separate contract.

If no provider is configured, `web_search` returns a graceful tool error. Alfred should say search is not configured rather than pretending `curl` is equivalent to search.

`web_search` should return structured results: title, URL, snippet, provider metadata, and optional provider summary. The main Alfred LLM produces the final spoken answer.

## Confirmation UX

For voice:

- If exactly one pending confirmation exists, accept: `yes`, `confirm`, `go ahead`, `do it`, or similar.
- If multiple pending confirmations exist, Alfred must ask which one.
- For dangerous actions, Alfred should include the exact command/tool payload and exact cwd/full path in the confirmation prompt.

For API:

- Prefer `confirmationId`.
- `confirm:true` is allowed only when exactly one pending confirmation exists.
- Confirmation executes the stored exact payload/hash, never a regenerated LLM command.

## Session Handoff UX

- Warn/prep a handoff at ~80k session tokens.
- At 100k session tokens, generate/save a handoff and ask the user to continue in a fresh session.
- Save full handoffs under `~/.alfred/handoffs/`.
- Speak only a short notice; put the full handoff path/content in `displayText`.

## File Edit Defaults

All file edits require confirmation for now, including source-code edits inside the current workspace.

Creating a new file inside the current workspace can be allowed without confirmation only when the user explicitly asked to create it and the path is clear.

Overwriting existing files always requires confirmation.

## Git Operation Safety

No confirmation required:

- `git status`
- `git diff`
- `git log`
- `gh pr view`
- other read-only git/GitHub inspection

Confirmation required:

- `git add`
- `git commit`
- `git stash`
- `git checkout`
- `git pull`
- `git merge`

Extra explicit confirmation required:

- `git push`
- `git reset --hard`
- `git clean`
- force push
- branch deletion

## Package Manager Safety

Confirmation required for package/environment mutations:

- `npm install`
- `npm uninstall`
- `npm audit fix`
- lockfile-changing package commands
- `pip install`
- `brew install`
- global installs/uninstalls

Diagnostic package commands such as `npm test`, `npm run lint`, `npm run typecheck`, `npm outdated`, and `npm audit` can run without confirmation.

## Long-Running Commands

Default timeouts:

- standard bash: 30 seconds
- tests: 5 minutes
- builds: 5 minutes

On timeout, Alfred reports and stops. It may ask whether to rerun with a longer timeout, but must not automatically rerun with a longer timeout in this phase.

## Autonomous Fixing Boundary

If the user asks Alfred to fix something, Alfred may inspect, run diagnostics, propose edits, and rerun safe checks.

However, because file edits require confirmation in this phase:

1. Alfred can read/search/run tests without asking.
2. Alfred must ask before applying each file edit/write.
3. After a confirmed edit, Alfred may rerun safe tests/checks without asking.
4. Commits/pushes always require separate confirmation.

This can be relaxed later once confidence is higher.

## Secrets Handling

Alfred should best-effort redact secrets before tool output is sent back to the LLM or stored in memory.

Redact common patterns:

- API keys/tokens
- bearer tokens
- private keys
- AWS/GitHub/OpenAI/DeepSeek-style keys
- `.env` values when read intentionally
- SSH private key material, though `.ssh` reads are hard-blocked elsewhere

Redaction is not a security boundary, but it should reduce accidental prompt/memory leakage.

## cmux Context Model

Do not inject full `cmux help` into every request forever.

Use the detailed `context-model.md` contract:

- always-on concise cmux cheat sheet and current workspace summary;
- cached full `cmux help` reference;
- on-demand help lookup when Alfred needs details.

The goal is not token penny-pinching. The goal is to behave like pi: keep useful context available, but fetch detailed docs/tools on demand instead of polluting every prompt.
