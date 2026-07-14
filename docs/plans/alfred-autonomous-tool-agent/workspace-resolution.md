# Workspace and CWD Resolution

## Core Principle

cmux is the source of truth for **where** Alfred acts. Conversation memory is the source of truth for **what** the user is referring to. Alfred must never silently substitute its own process cwd or the Alfred repo for either.

## Default Resolution Rule

When a tool needs a cwd/workspace and the user did not explicitly provide one:

1. Use the currently selected cmux workspace.
2. Within that workspace, prefer the active pane/current directory.
3. If the active pane is inside a git repo, use that repo root for repo-scoped operations.
4. If multiple repos are plausible, prefer the active pane's repo.
5. If cmux returns nothing or the target remains ambiguous:
   - read-only operations may make the best guess and announce it;
   - mutating operations must ask/confirm;
   - destructive operations must ask explicitly.

The Alfred repo is never the fallback cwd unless the user explicitly asks for the Alfred repo.

## Speech Aliases

Normalize these phrases to the current cmux workspace:

- here
- this repo
- current project
- my current workspace
- current workspace

## Workspace Names and Aliases

- Resolve spoken workspace names to cmux refs (`workspace:N`) at the boundary.
- Use refs internally; names are for display and speech.
- Support a configurable alias map, initially including:
  - main
  - sandbox
  - backend
  - frontend
  - alfred
  - powerco
- Automatically fuzzy-correct obvious speech recognition errors such as "Maine" → "Main" when there is no other plausible meaning.
- If multiple workspaces match, choose the currently active cmux workspace if it is one of the matches; otherwise ask.

## Conversation Memory Interaction

- Conversation memory can reinforce context but does not override cmux.
- If the user says "open sandbox" then later "run tests", use sandbox only if cmux still confirms sandbox is active or the user clearly refers back to sandbox.
- If the user has switched active workspaces between requests, cmux wins.
- Remember these within the session only:
  - last workspace
  - last file
  - last command
  - last browser tab/app/surface when cmux exposes it
- Do not persist workspace defaults across restarts.

## File Tools

- `read_file("package.json")` resolves relative to the current cmux workspace's active repo root.
- If the active pane is inside a subdirectory, use that directory's git root for repo files.
- If multiple repos exist in the workspace, prefer the active pane's repo.
- Reading: allowed without confirmation; announce what is being read.
- Editing/writing: requires confirmation unless creating a new file inside the current workspace.
- Overwriting existing files always requires confirmation.
- Files outside the current workspace require confirmation and must name the repo/path explicitly.
- Edits outside `/Users/muhammadabdul/work/` are blocked by default unless explicitly confirmed with the full path.

### Sensitive paths

- `~/.alfred/daemon.env`: allowed with confirmation.
- `.env` files: allowed with confirmation.
- `.ssh` files: hard block.
- System config files: hard block.
- Dotfiles: allowed with confirmation.

## Bash Commands

- Universal default: run bash tools in the resolved workspace cwd.
- App/system commands also receive the cwd internally, but Alfred should not mention cwd for commands where it is irrelevant, such as `open -a Firefox`.
- Git commands always run in the selected repo/workspace.
- Diagnostic/read-only commands run without confirmation:
  - `npm test`
  - `pytest`
  - `ruff`
  - `tsc`
  - `git status`
  - CI checks
- Mutating commands require confirmation:
  - `npm install`
  - package manager installs/removals
  - file writes/edits outside the current workspace
  - git commit/push/merge
- Destructive commands always require explicit confirmation:
  - `rm`
  - `git reset --hard`
  - `git clean`
  - force push
  - broad process kills

## Timeouts

Timeouts are category-based and configurable through `daemon.env`:

- Standard bash: 30 seconds
- Tests: 5 minutes
- Builds: 5 minutes

On timeout, Alfred reports and stops. Background continuation is out of scope for this phase.

## CI

- `ci_status` and `ci_logs` use the current cmux workspace repo by default.
- If there are multiple repos, active pane/directory wins.
- If still ambiguous, ask and name the options.
- Use `gh pr view` for the current branch first.
- If no PR exists, say so and then check branch-level GitHub Actions anyway.

## UX Rules

- Alfred should announce guesses for read-only actions: "Running that in sandbox, sir."
- Mutating confirmations must include the friendly alias and the exact full path.
- Dangerous confirmations must include the exact command and exact cwd/full path.
- If cwd is ambiguous for a mutation, block until workspace is clear.
