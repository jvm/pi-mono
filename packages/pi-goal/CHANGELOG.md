# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

## [0.1.11] - 2026-07-17

### Fixed

- Preserve accumulated wall-clock time when `/goal resume` is used on an already-active goal.
- Derive persisted `piGoalVersion` metadata from the package version so release versions cannot drift.
- Ignore malformed persisted mutations instead of allowing invalid status, budget, or accounting data to corrupt reconstructed goal state.

## [0.1.10] - 2026-07-01

### Changed

- Update Pi core development dependencies for Pi 0.80 compatibility.

## [0.1.9] - 2026-06-16

### Fixed

- Notify the model when a goal transitions to `budget_limited` or `usage_limited` so it can stop work and call `update_goal` instead of silently continuing to spend tokens after the budget is exhausted or the provider hits a rate limit. Previously the model was only ever informed via a UI notification that it could not see, leaving the current turn to keep running for additional assistant entries and allowing `update_goal` to mark the goal `complete` long after the budget had been blown.
- Branch the continuation prompt on the `budget_limited` reason so any future continuation of a budget-limited goal instructs the model to wrap up and call `update_goal` rather than push forward.

## [0.1.8] - 2026-06-08

### Fixed

- Add structured log metadata to pi-goal mutations and messages, including extension version, mutation source, tool-call trigger context, transition timing deltas, accounting diagnostics, provider-limit classifications, continuation context details, and optional terminal verification snapshots.
- Reject `update_goal` when it is batched with verification/tool calls in the same assistant turn, forcing completion/blocking decisions to happen after inspecting verification results.
- Preserve the elapsed-time fix for old sessions by ignoring legacy account mutation `timeUsedSeconds` fields during reconstruction.

## [0.1.7] - 2026-06-08

### Fixed

- Stop compounding active elapsed time during token accounting; active time is now materialized only on status transitions and computed live for display.

### Changed

- Pause goals on assistant-surfaced provider usage/quota/billing limit errors and repeated provider failures, not only HTTP 429 response hooks.

## [0.1.6] - 2026-06-06

### Changed

- Revert package name to `@mocito/pi-goal` (scoped) due to npm name conflict.
- Aligned package structure with monorepo guidelines (added root `index.ts` re-export, `.editorconfig`, `.gitignore`; fixed extension entry point; removed non-canonical tsconfig flags).
- Update `author` field to full name for monorepo consistency.

## [0.1.3] - 2026-06-06

### Changed

- Temporarily rename the package to unscoped `pi-goal`; this version was not published because that npm name was unavailable.

## [0.1.2] - 2026-05-28

### Changed

- Move the extension entry point to `extensions/index.ts` so Pi displays the package extension compactly.

## [0.1.1] - 2026-05-28

### Added

- Add best-effort install/update telemetry, gated by Pi telemetry/offline settings and disabled in CI.

## [0.1.0] - 2026-05-28

### Added

- Initial `@mocito/pi-goal` package with `/goal`, goal tools, branch-scoped session persistence, usage accounting, UI status, and automatic continuation.
