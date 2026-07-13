# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

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
