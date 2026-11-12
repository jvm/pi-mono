# Changelog

## [Unreleased]

## [0.4.3] - 2026-11-12

### Fixed

- Stop rejecting new managed commands in terminal mode after 32 failures that wait for `/processes` acknowledgment. Failed foreground results, already returned to the model, evict like other completed records; unacknowledged background and service failures evict last, oldest first. The record-cap error now appears only when every record is running or in use.
- Keep a service that fails before its launch call returns in the last eviction group, like other unacknowledged service and background failures, so the record cap does not remove its error output first.
- Wait for in-flight process launches when a session shuts down or reloads, so a command started during teardown cannot outlive the runtime or leave a record behind.

## [0.4.2] - 2026-11-03

### Added

- Show pending automatic background-result deliveries as a separate monitor count in the footer. Monitors clear when results reach model context, are explicitly handled, or the requesting task is disarmed.

### Fixed

- Update managed bash launch-card headings in place when processes finish, fail, time out, or stop. Lifecycle-driven redraws leave stored tool results and output previews unchanged.

## [0.4.1] - 2026-11-03

### Fixed

- Show only the live detached shell count in the footer and clear it when the last shell exits. Completed results, including failures, remain in `/processes` without stale footer warnings or completion feedback.

## [0.4.0] - 2026-10-30

### Changed

- Target Pi 1.4.0 for development and contract tests; older hosts are no longer test targets. Pi remains a host-supplied peer dependency.

### Added

- Group process tools in the discoverable `processes` namespace, including lifecycle, acknowledgement, and compact script recipes.

## [0.3.1] - 2026-10-25

### Fixed

- Preserve effective shell path and command-prefix settings when delegating ordinary bash calls.
- Keep a return cursor when entering tail/follow output, including before navigating the first log segment.
- Treat initial-call cancellation as an intentional stop, not a failure that needs attention or blocks record eviction. Timeouts remain failures.

### Added

- One live `/processes` manager with attention-first ordering, direct output navigation, line/page/segment scrolling, follow/pause, mode labels, inline confirmations, and keyboard help.
- Explicit per-process/all-failure acknowledgment, distinct intentional-stop status, and safe single/bulk completed-output cleanup. Human attention is independent of model delivery and inspection.
- Protect unacknowledged failures and active viewers from eviction. UI viewers pin retention without delaying background result delivery, and release timers/subscriptions/pins on close.

### Changed

- Extend `bash` with explicit foreground/background/service modes using `command` and `timeout` in seconds. Calls without a mode retain the built-in executor, output, truncation, and error behavior.
- Remove `exec_command` without a compatibility alias. Migrate scripts to `bash` with `command`, `timeout` in seconds, and explicit modes instead of legacy startup/completion options.
- Route managed bash through the existing process UI, completion coordinator, and per-write PTY approval. Pair with the matching DCG release for resolved-working-directory checks and full startup argument sealing.

## [0.3.0] - 2026-10-13

### Added

- Explicit foreground, background and service modes. Background commands deliver bounded output automatically at safe model boundaries and resume the requesting task without model-driven polling.
- Task-scoped completion coordination, batched results, finalized observation tracking, and explicit codemode acknowledgment. New user input or abort disarms old automatic delivery without stopping processes.
- Non-consuming `process_output` with independent byte cursors and a latest-output tail; event-driven `process_wait` for any/all dependencies, released by queued user input.
- Private temporary output storage, capped at 8 MiB per process and 32 MiB per runtime, plus independent 64,000-byte tails. Clean storage on eviction and orderly teardown.
- `/processes` output/stop panel with bounded pages, horizontal navigation, cursor segments, refresh and tail views, without model calls.
- Four-line collapsed process output, bounded expansion, compact status/loss summaries and historical completion rendering. Apply the same renderers to legacy empty `write_stdin` polls.
- Conservative validation provenance when Pi file-editing tools run during a command, and bounded foreground progress updates.

### Changed

- Default completion is silent: no delayed metadata backlog in conversation or model context. Automatic background results are model context, not visible bookkeeping messages.
- Foreground execution waits for final results by default. An explicit legacy `yield_time_ms` retains the earlier attachment behavior.
- Tool descriptions and parameter documentation express dependency-driven execution choices, independent work, readiness limits and the automatic delivery contract.
- Bound the live widget to three process rows; show brief completion feedback and retain failed-result attention status until inspection.

## [0.2.0] - 2026-10-12

### Added

- Persistent interactive widget for live background processes, with escaped command previews, session ID prefixes, pipe/PTY mode, and elapsed time. Update on process lifecycle events without polling or model calls; clear on completion and session teardown.
- Opt-in `completion_mode` delivers exit status and a bounded output tail through `nextTurn`, `followUp`, or `steer`. Steering reaches the next safe model boundary and wakes idle sessions. Preserve polling output and the legacy metadata-only `notify_on_exit` behavior.

## [0.1.0] - 2026-10-12

### Added

- Codex-inspired `exec_command` and `write_stdin` tools with pipe/PTY execution on macOS and Linux.
- Structured polling results, bounded output with explicit loss accounting, process listing, and process-group termination.
- Per-write input approval, session-owned cleanup, timeouts, and optional completion follow-up turns.
