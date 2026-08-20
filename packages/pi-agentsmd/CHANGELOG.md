# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

### Changed

- Share install telemetry mechanics through `@mocito/install-telemetry` while preserving Pi-specific settings and state paths.
- Generate concise `AGENTS.md` guidance from verified repository evidence instead of a fixed contributor-guide template.
- Make `/init --force` preserve accurate human-authored guidance while correcting stale or duplicate information.
- Monitor the upstream Codex prompt for useful changes without requiring the local prompt to remain identical.

### Fixed

- Let `enableInstallTelemetry: false` override an enabled `PI_TELEMETRY` environment flag.

## [0.1.3] - 2026-07-17

### Fixed

- Make `/init --force` and `/init -f` explicitly authorize replacing `AGENTS.md`.

## [0.1.2] - 2026-07-01

### Changed

- Update Pi core development dependency for Pi 0.80 compatibility.

### Fixed

- Sync init prompt with upstream Codex to refuse overwriting an existing AGENTS.md (resolves #12)

## [0.1.1] - 2026-06-08

### Fixed

- Apostrophe encoding in init prompt to match upstream Codex

## [0.1.0] - 2026-06-05

### Added

- Initial `pi-agentsmd` package scaffold.
- `/init` command to generate an `AGENTS.md` contributor guide for the current repository.
- `--force` flag to overwrite an existing `AGENTS.md` file.
- Init prompt adapted from OpenAI Codex (Apache 2.0).
