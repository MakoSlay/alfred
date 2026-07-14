# 003 — Workspace/CWD & Confirmation Invariants

## Goal

Make workspace/cwd resolution and confirmation execution exact, explicit, and testable.

## Why

Alfred 2 can run shell commands and edit files. Its biggest practical safety risk is not the LLM choosing a bad command; it is Alfred running a command in the wrong workspace or confirming a payload under a different cwd than the one previewed.

## Invariants

- Alfred never silently falls back to its own repo/process cwd for workspace-sensitive tools.
- Every workspace-sensitive tool execution has a resolved cwd, or the tool fails closed.
- If the user or model provides `workspaceRef`, Alfred resolves cwd from that workspace, not from the selected workspace.
- Confirmation previews include exact command/file path plus resolved cwd/workspace.
- Confirming executes the stored payload and stored execution context from the original prompt.
- Auto-confirm may skip ordinary mutation prompts, but never destructive/explicit prompts.

## Scope

**In scope:**

- Workspace resolution from pre-gathered cmux context.
- Tool call cwd/workspaceRef handling.
- Pending confirmation payload/context storage.
- Confirmation execution tests.
- Dashboard display of pending confirmation context if needed for verification.

**Out of scope:**

- Full target alias system from Alfred 1.
- cmux adapter rewrite.
- Remote workspaces.

## Checklist

- [ ] Add a resolver that maps `workspaceRef` to the corresponding parsed workspace cwd from the current system context.
- [ ] If a tool call includes `workspaceRef` and no cwd, use that workspace's cwd.
- [ ] If `workspaceRef` is unknown or lacks cwd, fail closed with a clear message.
- [ ] Prevent explicit `cwd` from escaping or contradicting a supplied `workspaceRef` unless there is a documented safe case.
- [ ] Store resolved cwd and workspaceRef in `PendingConfirmation`, not only inside the model payload.
- [ ] During confirmation, execute with the stored resolved cwd/workspaceRef, regardless of current selected workspace.
- [ ] Include cwd/workspace in confirmation preview and API response.
- [ ] Include cwd/workspace in tool result traces.

## Tests

- [ ] Model asks for bash in selected workspace → runs in selected workspace cwd.
- [ ] Model asks for bash with `workspaceRef` for a non-selected workspace → runs in that workspace cwd.
- [ ] Unknown `workspaceRef` → no execution.
- [ ] Workspace with no cwd → no execution.
- [ ] Confirmation requested in workspace A, selected workspace changes to B, then confirm → executes in workspace A.
- [ ] Auto-confirm does not bypass destructive commands.
- [ ] `npm run check` passes.

## Completion Criteria

- [ ] Alfred 2's workspace/cwd behavior is deterministic and documented.
- [ ] Confirmation cannot drift from the originally previewed execution context.
