# 001 - Context Gatherer

## Goal

Before every LLM call, gather the current state of the user's system — workspaces, git status, PRs, notifications, sidebar state — compress it, and inject it into the LLM prompt so the agent never wastes tokens on discovery commands.

## Dependencies

- Requires: None
- Blocks: 002, 006

## Scope

**In scope:**
- Gather all cmux workspaces (`cmux workspace list --json`)
- For each workspace: git branch, dirty status, recent commits (`git log --oneline -5`), open PR from sidebar state
- Gather sidebar state per workspace (`cmux sidebar-state --workspace <ref>`)
- Gather notifications (`cmux list-notifications`)
- Gather current workspace identity (`cmux identify`)
- Compress into a compact "STATE OF YOUR SYSTEM" text block (~2-4KB)
- Cache context for 5 seconds to avoid re-gathering on rapid successive calls
- Token counting: track how many tokens the context block consumes and how many discovery commands it replaces

**Out of scope:**
- File system scanning beyond git status
- Process list (ps/top) — add later if needed
- Network state
- Docker/container state

## Checklist

- [ ] Implement `gatherSystemContext()` function in `src/alfred-2/context.ts`
- [ ] Gather workspaces: parse `cmux workspace list --json`, extract ref, title, cwd, selected
- [ ] Gather git state per workspace: run `git -C <cwd> branch --show-current` and `git -C <cwd> status --porcelain` (timeout 3s each)
- [ ] Gather git log per workspace: `git -C <cwd> log --oneline -5` (timeout 3s)
- [ ] Gather sidebar state per workspace: `cmux sidebar-state --workspace <ref>`, extract git_branch, pr, ports, progress
- [ ] Gather notifications: `cmux list-notifications`, include title and read status
- [ ] Gather current identity: `cmux identify`, extract current workspace/surface
- [ ] Build compressed text block: one line per workspace, git status inline, PR info inline, notifications as bullet list
- [ ] Implement 5-second cache: `getContext()` returns cached context if < 5s old, otherwise re-gathers
- [ ] Count tokens in context block using simple tiktoken or character-based estimate
- [ ] Count how many discovery commands were avoided (always 7: workspace list, git branch × N, git log × N, sidebar state × N, notifications, identify)
- [ ] Add test: context block is under 4KB for typical workspace count (≤ 10)
- [ ] Add test: context block includes all workspaces even when git commands fail (graceful degradation)
- [ ] Add test: cache returns stale context within 5s, fresh context after 5s

## Tests

- [ ] Run `node --test --experimental-strip-types test/alfred-2/context.test.ts` — all pass
- [ ] Manual: run context gatherer, verify output is readable and complete
- [ ] Manual: verify token count is logged

## Completion Criteria

- [ ] `gatherSystemContext()` returns a compact, human-readable system state block in under 2 seconds
- [ ] Context block includes all workspaces, git branches, dirty flags, PRs, and notifications
- [ ] Cache prevents redundant gathering on rapid calls
- [ ] Token savings are computed and logged (discovery commands avoided × estimated tokens per command)
- [ ] Graceful degradation: missing cmux, missing git, empty workspaces all produce valid (possibly empty) context

## Notes

- This is the single most impactful feature for token efficiency. Without it, every LLM call starts with "list workspaces, check git status, check PRs..." — burning 5,000+ tokens before any reasoning happens.
- Target context block size: 2-4KB (~500-1000 tokens). Under 1KB for 1-3 workspaces. Over 4KB for 10+ workspaces with trimming.
- Context format should be LLM-friendly: concise labels, no JSON (wastes tokens on syntax), pipe-delimited key facts.
- Git commands may fail if a workspace cwd doesn't exist or isn't a git repo. Catch errors, report "no git" for that workspace, continue.
- The context block is prepended to the LLM system prompt as a "STATE OF YOUR SYSTEM" section, not as a user message (keeps it out of conversation history).
