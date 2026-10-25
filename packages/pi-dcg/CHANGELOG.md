# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

### Fixed

- Do not let extra `workdir` or `mode` arguments on ordinary bash select a different policy directory. Honor managed working directories only for the registered executor's local capability.

### Changed

- Check managed `bash` in its canonical working directory and freeze all approved bash arguments, including execution mode. Block argument changes during asynchronous policy checks.

## [0.4.1] - 2026-10-13

### Fixed

- Render terminal confirmation details in normal-weight text using the theme's text color instead of inheriting the title's bold accent style.

## [0.4.0] - 2026-10-12

### Added

- Guard `exec_command` process startup in its resolved working directory and seal all startup arguments. Keep incremental PTY input outside DCG's coverage; `pi-processes` requires separate per-write human approval.

## [0.3.0] - 2026-10-11

### Changed

- Compact the footer into palette-neutral Nerd Font shield variants for healthy, checking, and unavailable states. Keep `fail-open`/`blocking` in text when unavailable and keep version diagnostics in `/dcg`. Require Nerd Font 3 or later for icons; command guarding is unchanged.

## [0.2.0] - 2026-10-09

### Fixed

- Keep footer labels palette-neutral and terminal-only, preserving RPC confirmations and notifications.

### Changed

- Update the shared Pi development and contract-test baseline to 1.1.0; require Node.js >=22.19.0 to match the host runtime. Pi remains a host-supplied peer dependency.
- Share install telemetry mechanics through `@mocito/install-telemetry` while preserving Pi-specific settings and state paths.

### Fixed

- Let `enableInstallTelemetry: false` override an enabled `PI_TELEMETRY` environment flag.
- Cancel active and queued confirmations on turn abort or runtime shutdown, reject late approvals, and preserve cancellation blocking in both bridge-error modes.
- Serialize DCG confirmation dialogs so parallel bash calls cannot displace each other's prompt.

### Added

- Real Pi 1.1.0 session contracts for direct, codemode, and custom nested bash calls, with mocked provider/process/shell boundaries, native TUI selector checks, approval composition, reload, and user `!`/`!!` coverage.

### Security

- Document the remaining Pi 1.1.0 input-object replacement and cross-extension dialog scheduling limitations; DCG does not replace the host executor or claim those upstream gaps are fixed.

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

- Made checked-command sealing idempotent when the package is loaded at more than one Pi scope.
- Avoided empty stdin writes for probe commands, which could race with fast-exiting dcg binaries and falsely report that dcg was unavailable.

### Security

- Sealed approved agent `bash` commands and their input references so later Pi handlers cannot replace them after the dcg check.
- Kept dcg allow-once commands out of model-visible denial results while retaining user-only UI guidance.
- Documented that Pi's RPC control-channel `bash` command does not emit an extension event and therefore cannot be guarded by `pi-dcg`.
