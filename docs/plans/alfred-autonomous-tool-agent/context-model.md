# Context Model

## Principle

Alfred should behave like pi: keep a compact, useful context always available, and fetch detailed/reference information on demand.

The goal is not token minimization. The goal is reliability, freshness, and avoiding attention pollution.

## Always-On Context Per Request

Gather before each LLM request, with short caching where appropriate:

- current cmux workspace summary
- active workspace ref/name/path
- active pane cwd and inferred git repo root
- workspace aliases and refs
- notification count/short list
- recent sanitized conversation summary
- tool inventory summary
- concise cmux cheat sheet

## Cached Context

Cache semi-static or expensive references:

- full `cmux help`
- per-topic cmux help excerpts
- tool docs/usage examples
- provider capability info

Default cache behavior:

- workspace/current pane state: fetch each request, allow very short cache only for rapid duplicate requests (<=5s)
- full cmux help: cache for process lifetime or until cmux version/config changes
- cmux topic help: cache on first use

## On-Demand Context

Fetch only when needed through tools or pre-tool helpers:

- full cmux help
- cmux help for a specific command/topic
- screen contents
- file contents
- CI logs
- web search results
- fetched URL contents
- long history/handoff contents

## cmux Context Fetch Pattern

Before the LLM sees the user request, Alfred should gather the current cmux state summary. This is not considered an LLM tool call; it is request preparation.

The summary should be compact and include enough to resolve workspace/cwd safely.

If cmux is unavailable:

- read-only app/system requests may proceed with a warning;
- repo/file/git/CI operations should ask for clarification or fail safely;
- Alfred must not silently fall back to its own process cwd.

## cmux Help Pattern

Do not inject full `cmux help` every request.

Instead:

1. Inject concise cheat sheet from a small TypeScript constant in `context.ts`.
2. Allow `bash` to run targeted `cmux help`/`cmux docs` commands when needed.
3. Cache full help/reference internally for follow-up use.
4. Do not add a first-class `cmux_help` tool unless bash-based targeted discovery proves unreliable.

## Tests Required

- request preparation fetches current cmux workspace summary
- cmux unavailable does not cause fallback to Alfred repo
- full cmux help is not injected into every prompt
- targeted cmux help can be fetched/cached on demand
- recent rapid requests can use short workspace cache without changing cwd semantics
