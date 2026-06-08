# Changelog

## Unreleased

## 0.1.8 - 2026-06-08

### Fixed

- Add structured log metadata to pi-goal mutations and messages, including extension version, mutation source, tool-call trigger context, transition timing deltas, accounting diagnostics, provider-limit classifications, continuation context details, and optional terminal verification snapshots.
- Reject `update_goal` when it is batched with verification/tool calls in the same assistant turn, forcing completion/blocking decisions to happen after inspecting verification results.
- Preserve the elapsed-time fix for old sessions by ignoring legacy account mutation `timeUsedSeconds` fields during reconstruction.

## 0.1.7 - 2026-06-08

### Fixed

- Stop compounding active elapsed time during token accounting; active time is now materialized only on status transitions and computed live for display.

### Changed

- Pause goals on assistant-surfaced provider usage/quota/billing limit errors and repeated provider failures, not only HTTP 429 response hooks.

## 0.1.6 - 2026-06-06

### Changed

- Revert package name to `@mocito/pi-goal` (scoped) due to npm name conflict.
- Aligned package structure with monorepo guidelines (added root `index.ts` re-export, `.editorconfig`, `.gitignore`; fixed extension entry point; removed non-canonical tsconfig flags).
- Update `author` field to full name for monorepo consistency.

## 0.1.3

- Move the extension entry point to `extensions/index.ts` so Pi displays the package extension compactly.

## 0.1.1

- Add best-effort install/update telemetry, gated by Pi telemetry/offline settings and disabled in CI.

## 0.1.0

- Initial `@mocito/pi-goal` package with `/goal`, goal tools, branch-scoped session persistence, usage accounting, UI status, and automatic continuation.
