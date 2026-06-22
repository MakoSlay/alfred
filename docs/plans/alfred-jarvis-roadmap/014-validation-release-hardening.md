# 014 - Validation and Release Hardening

## Goal

Harden the Jarvis roadmap milestone with end-to-end validation, documentation, migration notes, and release readiness checks.

## Dependencies

- Requires: 010, 011, 012, 013
- Blocks: None

## Scope

**In scope:**
- Run full automated gates and targeted manual QA across daemon, dashboard, cmux integration, watchers, and Pi fallback.
- Update README/docs with user-facing setup, capability, permission, watcher, and troubleshooting guidance.
- Document known limitations and safe rollback paths.

**Out of scope:**
- Adding new product features not already covered by earlier tasks.
- Public cloud deployment or multi-user hosting.

## Checklist

- [ ] Build a manual QA matrix covering cmux available/unavailable, daemon restart, dashboard auth, Ask Alfred, action cards, notifications, watchers, and Pi fallback.
- [ ] Run the full project gate and fix any failures caused by roadmap work.
- [ ] Verify local persistence, target memory, and audit history contain no committed secrets or transcript dumps.
- [ ] Update README and docs with new usage examples and configuration options.
- [ ] Add migration/rollback notes for users who only want the stable foundation behavior.
- [ ] Review all new restricted actions for explicit permission and confirmation coverage.

## Tests

- [ ] Run `npm run typecheck` and verify all types pass.
- [ ] Run `npm test` and verify all tests pass.
- [ ] Run `npm run check` and verify the full project gate passes.
- [ ] Manual QA: complete the roadmap QA matrix and record any residual risks in docs or follow-up issues.

## Completion Criteria

- [ ] Automated gates pass for the completed roadmap work.
- [ ] Manual QA covers all major Alfred/cmux flows added by this plan.
- [ ] Documentation explains what Alfred can do, what requires confirmation, and how to roll back.
- [ ] No roadmap feature breaks existing daemon startup, dashboard access, or Pi-local fallback.

## Notes

- This task should not become a catch-all implementation bucket; create follow-up plans for new scope.
