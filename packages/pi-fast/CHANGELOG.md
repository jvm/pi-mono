# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

## [0.1.1] - 2026-08-11

### Added

- Add the global `pi-fast.enabledByDefault` setting to start sessions with Fast mode enabled for all supported models.

### Changed

- Share install telemetry mechanics through `@mocito/install-telemetry` while preserving Pi-specific settings and state paths.

### Fixed

- Let `enableInstallTelemetry: false` override an enabled `PI_TELEMETRY` environment flag.

## [0.1.0] - 2026-08-02

### Added

- Initial `pi-fast` extension.
- Session-local `/fast` command and `Ctrl+Shift+F` toggle.
- OpenAI Codex Fast mode for models that advertise the `priority` service tier.
- Footer status for Fast mode state.
