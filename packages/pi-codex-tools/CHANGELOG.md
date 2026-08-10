# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

### Changed

- Keep provider-side parallel tool calls enabled while preserving sequential `apply_patch` execution.

### Fixed

- Strip untrusted terminal control sequences from `apply_patch` previews before rendering them in the Pi TUI.

## [0.2.1] - 2026-08-08

### Fixed

- Stop npm from running `node-gyp rebuild` on install. The package ships prebuilt native bindings and loads them at runtime, but npm's gypfile detection keyed off the dev-only `binding.gyp` and injected a failing `node-gyp rebuild` into the install lifecycle — breaking install on machines without a build toolchain (e.g. Linux). Set `gypfile: false` to suppress it.

## [0.2.0] - 2026-08-08

### Added

- macOS support for `apply_patch` via a bundled `openat` / `mkdirat` / `unlinkat` N-API binding, prebuilt for Apple silicon and Intel. The TOCTOU-safe no-follow directory walk now runs on macOS with parity to Linux, so supported Codex models can use `apply_patch` on macOS (previously Linux-only).

### Fixed

- Keep `edit` and `write` active on platforms where `apply_patch` cannot run. The tool swap was gated solely on model grammar capability, so unsupported platforms (macOS) replaced the native file tools with `apply_patch` and then failed at execution; activation now also requires the secure filesystem to be supported.

## [0.1.3] - 2026-08-06

### Fixed

- Trim patch header paths in the streaming preview so whitespace-padded headers coalesce and render the same way execution does (it trims via `headerPath`).

## [0.1.2] - 2026-08-06

### Added

- Stream `apply_patch` progress in the TUI: while a patch is generated the tool now shows a live diff glimpse of the content being written plus a running `+added -removed` tally (and a capped per-file roster for multi-file patches), reusing Pi's shared diff rendering. Moves render the source → destination transition, and the preview is byte/file bounded for responsiveness. Execution behavior is unchanged.

## [0.1.1] - 2026-08-04

### Fixed

- Guard `apply_patch` execution when the active model does not advertise grammar-tool support.
- Require the Pi runtime grammar-tool contract and fail closed on unsupported filesystem platforms.
- Preflight repeated file hunks sequentially without rejecting valid Codex patches.
- Respect `enableInstallTelemetry: false` even when `PI_TELEMETRY` is enabled.
- Document credential-containing target reads, telemetry controls, runtime requirements, and line-oriented compatibility.

## [0.1.0] - 2026-08-03

### Added

- Initial `pi-codex-tools` extension.
- Codex-compatible raw `apply_patch` grammar tooling and capability-based model activation.
- Supported models replace Pi's `edit` and `write` tools with `apply_patch` and restore their previous active states when switching models.

### Fixed

- Preserve indented patch marker lines as update context instead of interpreting them as control markers.
- Anchor filesystem mutations to no-follow directory descriptors on Linux/macOS and fail closed on unsupported platforms.
- Bound target-file reads and use linear hunk matching to prevent unbounded memory and quadratic matching work.
