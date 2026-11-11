# Changelog

## [Unreleased]

### Added

- Enable reasoning updates on Codex `gpt-6.1-sol` and `gpt-6.1-terra`, which the upstream Codex catalog marks with `supports_reasoning_effort_updates`. They are not yet verified against the live backend ([#219](https://github.com/jvm/pi-mono/issues/219)).
- Opt a Codex model in or out with `compat.supportsMidConvoEffort` in `models.json`, for example for `gpt-6-luna`, which the upstream catalog does not mark.

### Changed

- Document that thinking `off` (effort `none`) stays Pi's ordinary request effort, without an update.

## [0.2.1] - 2026-10-30

### Changed

- Target Pi 1.4.0 for development and contract tests; older hosts are no longer test targets. Pi remains a host-supplied peer dependency.

### Fixed

- Reset reasoning after a compacted checkpoint preceded by Pi 1.4's inline tool declarations, preserving declaration order and fingerprinting their exact content.

## [0.2.0] - 2026-10-09

### Documentation

- Add a provider/auth/model support matrix and evidence-backed migration assessment; retain legacy Astra-only guards and distinguish public reasoning updates from Pi sampling settings.

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
