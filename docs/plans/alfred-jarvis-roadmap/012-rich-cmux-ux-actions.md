# 012 - Rich Cmux UX Actions

## Goal

Expose safe Alfred actions that delegate rich UI work to native cmux surfaces for diffs, markdown, files, URLs, and browser inspection.

## Dependencies

- Requires: 001, 002, 004
- Blocks: 013, 014

## Scope

**In scope:**
- Wire safe direct actions for opening diffs, markdown plans, files, URLs, browser splits, browser snapshots, and unread targets using cmux adapter methods.
- Permission-gate browser click/type/eval through temporary scoped grants; read/open/snapshot remains safe.
- Add previews that make it obvious what cmux will open or inspect, even when no confirmation is required.

**Out of scope:**
- Building a duplicate markdown/diff/browser viewer inside Alfred.
- Free-form browser automation without restricted permission checks.

## Checklist

- [ ] Complete or extend registry actions for `cmux diff`, `cmux markdown open`, `cmux open`, `cmux browser open`, and browser snapshot/read-only inspection.
- [ ] Mark read-only/open/show cmux UI actions as safe direct actions by default.
- [ ] Define temporary scoped grants for browser click/type/eval actions.
- [ ] Add intent-router phrases for "show diff", "open plan", "open file", "open URL", and "inspect browser".
- [ ] Render action previews with target workspace/surface and focus behavior.
- [ ] Document unsupported or restricted cmux browser actions.

## Tests

- [ ] Run `npm run typecheck` and verify rich action contracts compile.
- [ ] Run `npm test` and verify action validation, permission gating, and command construction.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA inside cmux: ask Alfred to open an unstaged diff and a markdown plan, then verify cmux opens native surfaces.

## Completion Criteria

- [ ] Alfred can execute safe rich cmux UI actions directly with clear previews/history.
- [ ] Browser click/type/eval actions require confirmation or a temporary scoped permission grant.
- [ ] Alfred does not duplicate cmux markdown, diff, file, URL, or browser surfaces.

## Notes

- Prefer `--no-focus` or explicit focus previews where cmux supports it so Alfred does not surprise the operator.
- Verified command families include `cmux diff`, `cmux markdown open`, `cmux open`, and `cmux browser open`; browser mutation commands remain restricted.
- Safe local cmux UI actions include opening diffs, markdown, file previews, URL/browser surfaces, reading notifications, jumping/focusing cmux UI, and writing Alfred status/progress/logs to the sidebar.
