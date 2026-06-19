# CMUX Operator

A local, cmux-backed agent orchestration server for coordinating Pi, Codex, and other terminal-based agent sessions.

This project is intentionally separate from `pi-smart-voice-notify`. The current Pi extension remains the live/default `/alfred` implementation while CMUX Operator is built in parallel.

## Plan

See:

```text
docs/plans/cmux-operator/PLAN.md
```

## Initial Goal

Build a local runtime/daemon that uses cmux as the workspace/surface substrate, then expose it through CLI, web UI, and optional Pi extension bridge clients.
