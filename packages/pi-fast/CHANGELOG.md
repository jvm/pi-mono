# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

## [0.3.0] - 2026-10-09

### Fixed

- Keep footer state labels palette-neutral instead of retaining ANSI colors from a previous theme.

### Documentation

- Add provider/auth/billing and safe-fallback matrix; correct the native OAuth smoke-test explanation for the Pi 1.1.0 baseline.

### Changed

- Remove the obsolete direct-compaction event-bus adapter. Public server-side compaction keeps the normal request's Fast tier; legacy provider inference support is unchanged.
- Update the shared Pi development and contract-test baseline to 1.1.0; require Node.js >=22.19.0 to match the host runtime. Pi remains a host-supplied peer dependency.

## [0.2.0] - 2026-10-02

### Added

- Support GPT-6.1 Sol Fast mode, including cooperating compaction requests.
- Support the `openai` provider with API keys or ChatGPT OAuth on `openai-responses`, while keeping legacy `openai-codex` support.

### Changed

- Default to `fast` for OpenAI API keys and use `priority` for ChatGPT OAuth and legacy Codex compatibility. Select the tier on each request, including cooperating compaction requests, so authentication changes take effect without another toggle.
- Clarify API charges, subscription usage, and requested versus delivered service tiers.

## [0.1.3] - 2026-09-22

### Fixed

- Recognize GPT-6 Sol and Luna Fast support on the Codex subscription backend, including cooperating compaction requests. Keep GPT-6 Astra support.

## [0.1.2] - 2026-09-11

### Added

- Support GPT-6 Astra Fast mode on the Codex subscription backend.
- Apply the current Fast toggle to cooperating Codex compaction requests.

### Changed

- Move the Fast mode shortcut from `Ctrl+Shift+F` to `Ctrl+Shift+R` to avoid Pi's transcript search shortcut.

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
