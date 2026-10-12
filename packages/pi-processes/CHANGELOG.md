# Changelog

## [Unreleased]

## [0.2.0] - 2026-10-12

### Added

- Persistent interactive widget for live background processes, with escaped command previews, session ID prefixes, pipe/PTY mode, and elapsed time. Update on process lifecycle events without polling or model calls; clear on completion and session teardown.
- Opt-in `completion_mode` delivers exit status and a bounded output tail through `nextTurn`, `followUp`, or `steer`. Steering reaches the next safe model boundary and wakes idle sessions. Preserve polling output and the legacy metadata-only `notify_on_exit` behavior.

## [0.1.0] - 2026-10-12

### Added

- Codex-inspired `exec_command` and `write_stdin` tools with pipe/PTY execution on macOS and Linux.
- Structured polling results, bounded output with explicit loss accounting, process listing, and process-group termination.
- Per-write input approval, session-owned cleanup, timeouts, and optional completion follow-up turns.
