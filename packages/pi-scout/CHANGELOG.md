# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

### Fixed

- Store temporary clones in a private per-user directory and reject unsafe clone roots.
- Serialize repository state mutations and persist state through atomic file replacement.

## [0.1.3] - 2026-07-01

### Changed

- Update Pi core development dependency for Pi 0.80 compatibility.

## [0.1.2] - 2026-06-06

### Changed

- Update `author` field to full name for monorepo consistency.

## [0.1.1] - TBD

### Added

- Add install/update telemetry ping to `mocito.dev`, gated by Pi telemetry/offline settings and disabled in CI.

## [0.1.0] - TBD

### Added

- Initial `pi-scout` package scaffold.
- `/scout` command for registering, listing, and removing reference repositories.
- `scout_add` and conditional `scout_rm` tools.
- Compact system prompt injection for registered local repository paths with stale-temp pruning.
- GitHub `owner/repo` shorthand for repository registration.
- `scout_add` tool schema minimized to a single `source` parameter.
- Repository registration now defaults to shallow clones with depth `1`.
- Unix-like systems now use `/tmp/pi-scout` for shorter registered paths.
- Package-level extension entry point so Pi displays the extension as `pi-scout` instead of `extensions`/`extension`.
- Optional temporary clone deletion when removing repository records.
