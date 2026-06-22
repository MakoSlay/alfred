# 001 - Cmux Adapter Foundation

## Goal

Create a single daemon-side adapter for the cmux capabilities Alfred should use instead of shelling out from scattered feature code.

## Dependencies

- Requires: existing Alfred daemon and cmux discovery foundation from `docs/plans/alfred/`
- Blocks: 002, 003, 004, 007, 008, 011, 012

## Scope

**In scope:**
- Add typed adapter methods for cmux identity, capabilities, tree, workspaces, panes, surfaces, notifications, sidebar status/progress/log/state, terminal read/send/key, markdown, diff, file/url open, and browser open/read-only entry points.
- Normalize cmux refs, JSON parsing, text parsing where cmux has no JSON output, command timeouts, and error shapes.
- Add fixture-backed tests for cmux command output and exact argument-array command construction that Alfred depends on.
- Verify installed cmux CLI syntax on the developer machine before locking fixtures or plan wording.

**Out of scope:**
- Natural language planning, permission policy, recipe execution, or dashboard UI changes.
- Implementing features that cmux itself already owns.
- Browser click/type/eval mutation handlers; adapter entry points may exist later, but policy/temporary grants own whether they can run.

## Checklist

- [ ] Inventory current `src/cmux` code and identify direct cmux command usage outside the adapter.
- [ ] Define adapter types for identity, capabilities, windows, workspaces, panes, surfaces, notifications, sidebar state, and command results.
- [ ] Implement adapter methods using cmux CLI commands with explicit timeouts and JSON/text parsing rules.
- [ ] Prefer JSON commands where available and text parsers only where cmux exposes text output.
- [ ] Replace scattered cmux calls in daemon code with the adapter where practical.
- [ ] Add fixtures for `identify`, workspace list, workspace tree, `list-notifications`, `sidebar-state`, command failures, malformed JSON, and argument preservation.
- [ ] Document which cmux features Alfred treats as substrate primitives.

## Verified cmux CLI Notes

These command shapes were verified against the installed cmux CLI and should be preferred unless a later cmux version changes them:

- Capabilities: `cmux capabilities`
- Identity: `cmux identify --id-format both`
- Workspaces: `cmux workspace list --json --id-format both`
- Tree/surfaces: `cmux tree --workspace <ref> --json --id-format both` with text-tree fallback if JSON parsing fails.
- Terminal read: `cmux read-screen --surface <ref> --scrollback --lines <n>`
- Terminal send/key: `cmux send --surface <ref> <text>`, `cmux send-key --surface <ref> <key>`; workspace variants use `--workspace <ref>`.
- Notifications: `cmux list-notifications --json --id-format both`, `dismiss-notification`, `mark-notification-read`, `open-notification`, `jump-to-unread`, `clear-notifications`.
- Sidebar: `cmux set-status`, `set-progress`, `clear-progress`, `log`, `list-status`, `sidebar-state`. `sidebar-state` is key/value text output, not JSON.
- Rich UI: `cmux markdown open <path>`, `cmux diff ...`, `cmux open <path-or-url>`, `cmux browser open [url]`.
- Events: `cmux events` exists but should remain optional until reliability/cursor semantics are validated for Alfred.

## Tests

- [ ] Run `npm run typecheck` and verify all TypeScript types pass.
- [ ] Run `npm test` and verify adapter fixtures pass.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA inside cmux: compare adapter output against `cmux identify --id-format both`, `cmux workspace list --json --id-format both`, and `cmux tree --workspace <ref> --json --id-format both`.

## Completion Criteria

- [ ] All cmux interactions required by the early roadmap are exposed through one typed adapter surface.
- [ ] Existing daemon behavior still passes tests after adapter consolidation.
- [ ] Adapter errors are structured enough for callers to show safe user-facing messages.
- [ ] Later tasks can add daemon/UI behavior without adding new direct cmux shell calls outside `src/cmux/index.ts`.

## Notes

- Prefer native cmux commands over recreating cmux state in Alfred.
- Preserve the existing safe fallback behavior when cmux is unavailable or malformed output is returned.
- This task is an adapter foundation; executing product actions still belongs behind the registry and permission model in Task 002+.
