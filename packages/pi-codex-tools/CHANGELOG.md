# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

## [0.1.0] - 2026-08-03

### Added

- Initial `pi-codex-tools` extension.
- Codex-compatible raw `apply_patch` grammar tooling and capability-based model activation.
- Supported models replace Pi's `edit` and `write` tools with `apply_patch` and restore their previous active states when switching models.

### Fixed

- Preserve indented patch marker lines as update context instead of interpreting them as control markers.
- Anchor filesystem mutations to no-follow directory descriptors on Linux/macOS and fail closed on unsupported platforms.
- Bound target-file reads and use linear hunk matching to prevent unbounded memory and quadratic matching work.
