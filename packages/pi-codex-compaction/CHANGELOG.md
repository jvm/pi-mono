# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

### Fixed

- Let `enableInstallTelemetry: false` override an enabled `PI_TELEMETRY` environment flag.
- Keep the normal Codex Responses request envelope while excluding Pi's retained user input from compaction history.
- Avoid reusing opaque checkpoints across model, endpoint, account, or authentication-mode changes.
- Reject version 1 opaque checkpoints from existing sessions and use readable fallback context until a new checkpoint is created.
- Fall back to Pi's standard compactor when custom compaction instructions are supplied.

### Added

- Incremental bounded SSE parsing, transient request retries, response idle timeouts, provider usage capture, and file-operation fallback metadata.
- Trusted-origin and redirect protections for direct Codex compaction requests.

## [0.1.0] - 2026-08-02

### Added

- Initial `pi-codex-compaction` extension.
- OpenAI Codex RemoteCompactionV2 support with standard Pi compaction fallback.
- Opaque checkpoint persistence and bounded cross-model fallback context.

### Fixed

- Use Pi's compat provider entry point so the extension loads through the runtime extension loader.
- Rehydrate summaries emitted as untyped Responses message items after model switches.
