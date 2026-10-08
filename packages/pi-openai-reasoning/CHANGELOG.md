# Changelog

## [Unreleased]

### Changed

- Remove the legacy direct-compaction event-bus adapter and update integration/smoke tests to use Pi's standard summarizer. `pi-codex-compaction` now targets the public OpenAI route; this package's legacy-provider scope is unchanged.
- Update the shared Pi development and contract-test baseline to 1.1.0; require Node.js >=22.19.0 to match the host runtime. Pi remains a host-supplied peer dependency.

## [0.1.0] - 2026-09-11

### Added

- Codex-only Astra reasoning updates with a fixed request effort.
- Branch-local replay, retry stability and compaction integration.
- Existing Pi thinking controls, OAuth reuse, bounded metadata and install telemetry.

### Fixed

- Enforce the history byte budget during fingerprint serialization, before fully traversing oversized input items.
