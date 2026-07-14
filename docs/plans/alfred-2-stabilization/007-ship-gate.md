# 007 — Stabilization Ship Gate

## Goal

Make sure Alfred 2 stabilization is safe to use daily before adding more capabilities.

## Dependencies

- Requires: 001 through 006 complete.

## Checklist

- [ ] Architecture docs are updated and stale contradictions are resolved.
- [ ] Server/dashboard security tests pass.
- [ ] Workspace/cwd/confirmation invariant tests pass.
- [ ] Dashboard observability tests pass.
- [ ] Manual voice smoke matrix is completed.
- [ ] Docs/runbook are updated.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run check` passes.
- [ ] Review unstaged diff for accidental secrets, logs, or generated files.
- [ ] Confirm Alfred 1 daemon tests still pass and no Alfred 1 behavior regressed.

## Manual Release Notes Template

- What changed:
- Safety/security changes:
- Known limitations:
- Required env/config changes:
- Smoke tests run:

## Completion Criteria

- [ ] Alfred 2 is safe and reliable enough for daily voice-agent dogfooding.
- [ ] Future work can focus on quality of workflows and selected new capabilities rather than core safety fixes.
