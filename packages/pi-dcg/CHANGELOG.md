# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

## [0.1.0] - 2026-07-17

### Added

- Initial `pi-dcg` Pi package.
- Guarding for agent `bash` calls and user `!`/`!!` commands through dcg's hook protocol.
- Pi-native handling for allow, deny, and ask decisions.
- Bounded, cancellable dcg subprocess execution with configurable bridge error behavior.
- Startup health status and `/dcg` diagnostics command.
- Best-effort install/update telemetry following monorepo policy.
- Unit and integration coverage for protocol, process, client, and extension behavior.

### Fixed

- Avoided empty stdin writes for probe commands, which could race with fast-exiting dcg binaries and falsely report that dcg was unavailable.

### Security

- Documented that Pi's RPC control-channel `bash` command does not emit an extension event and therefore cannot be guarded by `pi-dcg`.
