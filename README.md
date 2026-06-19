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
