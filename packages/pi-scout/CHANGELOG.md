# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

## [0.1.0] - TBD

### Added

- Initial `pi-scout` package scaffold.
- `/scout` command for registering, listing, and removing reference repositories.
- `scout_add` and conditional `scout_rm` tools.
- Compact system prompt injection for registered local repository paths with stale-temp pruning.
- GitHub `owner/repo` shorthand for repository registration.
- `scout_add` tool schema minimized to a single `source` parameter.
- Optional temporary clone deletion when removing repository records.
