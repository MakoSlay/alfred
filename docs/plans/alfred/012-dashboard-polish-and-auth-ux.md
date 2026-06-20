# 012 - Dashboard Polish and Auth UX

## Goal

Improve the local dashboard after daemon startup, planning, and persistence foundations are stable, while preserving Alfred's local security model.

## Dependencies

- Requires: 008
- Related: 010 for loop status display and 011 for persisted history display
- Blocks: None

## Scope

Refactor and polish the current embedded dashboard only after daemon basics are usable. Keep dashboard changes incremental and guarded by the existing localhost host/origin/token checks.

**In scope:**

- Split dashboard HTML/client code out of `src/daemon/index.ts` if it improves maintainability.
- Improve token entry/status UX without leaking tokens into logs, URLs, or committed files.
- Display daemon health, surfaces, pending drafts, recent events, and loop status more clearly.
- Add safer confirm/cancel interactions.
- Add focused tests for route security and dashboard rendering behavior.

**Out of scope:**

- Public web app hosting.
- Relaxing local auth protections.
- Complex frontend framework/build pipeline unless explicitly justified.
- Long-lived token storage beyond local browser/operator convenience.

## Checklist

- [ ] Decide whether to keep embedded HTML or extract dashboard rendering/client script into a separate module/file.
- [ ] Improve dashboard copy for token entry, generated-token handling, and safe local use.
- [ ] Add visible daemon health, configured endpoint, and last-refresh/error state.
- [ ] Add loop status once task 010 exposes it, or keep a clear placeholder if not ready.
- [ ] Ensure all dynamic data rendering stays injection-safe and redaction-aware.
- [ ] Preserve no permissive CORS, strict host/origin guard, `no-store`, `nosniff`, and CSP protections.
- [ ] Add/adjust tests for dashboard route, auth API calls, no token embedding, and state-changing controls.

## Tests

```bash
cd /Users/muhammadabdul/work/alfred
npm run check
npm run typecheck
npm test
```

Manual dashboard smoke:

```bash
cd /Users/muhammadabdul/work/alfred
ALFRED_LOCAL_TOKEN=dev-local-token npm run daemon
open http://127.0.0.1:47321/dashboard
```

Verify the dashboard can refresh state, show surfaces/events, and confirm/cancel drafts with the token entered manually.

## Completion Criteria

- [ ] Dashboard remains local-only and guarded.
- [ ] Dashboard source is maintainable enough for the next feature phase.
- [ ] Token UX is clearer and does not introduce secret leakage.
- [ ] Dashboard displays the daemon state needed for live Alfred operation.
- [ ] Standalone Alfred gates pass.

## Notes

- This is intentionally lower priority than 008-011. Avoid polishing UI before the daemon has a real start path and behavior worth operating.
- Do not put tokens in query strings unless there is a deliberate, documented local-only rationale; prefer manual entry or a safer bootstrap instruction.

## Blockers

- Best started after 008.
- Loop display depends on 010.
- Persistence display/history expectations depend on 011.
