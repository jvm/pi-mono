# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

### Fixed

- Keep macOS sleep inhibition active across automatic retries, compaction retries, and queued follow-up work until Pi emits `agent_settled`.

## [0.1.2] - 2026-07-01

### Changed

- Update Pi core development dependency for Pi 0.80 compatibility.

## [0.1.1] - 2026-06-09

## [0.1.0] - TBD

### Added

- Initial `pi-insomnia` package scaffold.
- Automatic macOS idle sleep inhibition while Pi agent runs are active.
- Cleanup on agent completion and session shutdown.
- Footer status indicator while sleep inhibition is active.
- Best-effort install/update telemetry ping to `mocito.dev`, gated by Pi telemetry/offline settings and disabled in CI.
