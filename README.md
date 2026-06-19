# Alfred

Alfred is a local, cmux-backed personal assistant that can observe, coordinate, and safely command Pi, Codex, shells, and other terminal agents or processes running inside cmux.

This project is intentionally separate from `pi-smart-voice-notify`. The current Pi extension remains the live/default `/alfred` implementation while Alfred is built in parallel, but the long-term goal is for Alfred to own its runtime and use Pi as one target/interface rather than living inside Pi.

## Plan

See:

```text
docs/plans/alfred/PLAN.md
```

## Initial Goal

Build a local runtime/daemon that uses cmux as the workspace/surface substrate, then expose it through `/alfred` in Pi, CLI, web UI, and eventually non-Pi voice/input surfaces.

## Development

The current Pi extension remains the live/default `/alfred` path while this repo is built in parallel.

```bash
npm install
npm run check
npm run typecheck
npm test
```

Initial source layout:

```text
src/contracts/   Shared request/response/action/event contracts
src/core/        Alfred core runtime placeholder
src/cmux/        cmux world-model adapter placeholder
src/daemon/      daemon/server placeholder
src/cli/         CLI source placeholder
src/web/         web/dashboard source placeholder
src/testing/     contract fixtures and test helpers
```
