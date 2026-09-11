# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

## [0.1.13] - 2026-09-11

### Added

- Report backend image metadata, generation stages, byte counts, and elapsed time without guessing the served image model.
- Support Flare and Sunburst Images 2.5 API model IDs and their September 8 snapshots with `xhigh` and `max` CLI quality settings. Keep existing defaults.
- Validate documented flexible dimensions for both 2.5 models and the GPT Image 2 dated snapshot in CLI generation, editing, and batch workflows.

### Changed

- Describe the Codex image model as backend-selected. Report its ID only if the backend supplies one; otherwise return `backendImageModel: "unknown"`.
- Share install telemetry mechanics through `@mocito/install-telemetry` while preserving Pi-specific settings and state paths.

### Fixed

- Identify subscription requests with a Pi User-Agent and distinguish Cloudflare challenges from account/model failures.
- Bound network time, streamed/error output, prompts, and input images; handle fragmented CRLF streams and incomplete results; avoid quota-error retries and accidental file overwrites.
- Allow GPT Image 2 native transparency preview with PNG/WebP in the API CLI, and remove outdated older-model fallback requirements from skill guidance.
- Let `enableInstallTelemetry: false` override an enabled `PI_TELEMETRY` environment flag.

## [0.1.12] - 2026-07-17

### Added

- Add native edits using up to five local or recent conversation images.
- Honor bounded `Retry-After` delays and make retry backoff abort-aware.

### Fixed

- Strictly validate base64 data and output-format signatures before returning or saving images.
- Preserve valid inline images and report a warning when disk persistence fails.
- Keep original generated artifacts when copying selected outputs elsewhere by default.

## [0.1.11] - 2026-07-01

### Changed

- Update Pi core development dependencies for Pi 0.80 compatibility.

## [0.1.10] - 2026-06-06

### Changed

- Restructured package to follow monorepo guidelines (added root `index.ts` re-export, moved extension code to `extensions/index.ts`, extracted telemetry to `src/install-telemetry.ts`).
- Update `author` field to full name for monorepo consistency.

## [0.1.9] - 2026-05-20

### Changed

- Moved package source to the `jvm/pi-mono` monorepo.
- Updated npm metadata to point at the monorepo package directory.

## [0.1.8] - 2026-05-10

### Fixed

- Disable install/update telemetry automatically in CI environments.

## [0.1.7] - 2026-05-10

### Added

- Install/update telemetry ping to `mocito.dev`, gated by Pi telemetry/offline settings and deduplicated per package version.

## [0.1.6] - 2026-05-09

### Changed

- Switched development, CI, and publish workflows from Bun to npm with `package-lock.json` for better Pi package consistency.

## [0.1.5] - 2026-05-07

### Added

- CI workflow running type-check and `pack:dry-run` on every push and PR.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- GitHub PR template and issue templates (bug report, feature request).
- `.editorconfig` for consistent editor settings.

### Changed

- `peerDependencies` relaxed to `"*"`; pinned versions moved to `devDependencies`.
- `tsconfig.json` module resolution updated from `Node16` to `NodeNext`.
- `package.json`: added `author`, `bugs`, `homepage`, `publishConfig.access`, `engines`, `pi-extension` keyword; community docs included in published `files`.

## [0.1.4] - 2026-05-07

### Fixed

- Added `repository.url` to `package.json`, required by npm provenance (sigstore) verification.

## [0.1.3] - 2026-05-07

### Changed

- Migrated peer dependencies from `@mariozechner` to `@earendil-works` scope (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` v0.74.0).

### Added

- `.github/workflows/publish.yml`: OIDC-based npm publish triggered on GitHub release.
- `scripts.check` and `scripts.pack:dry-run` in `package.json`.

## [0.1.2] - 2025

### Changed

- Moved extension entry point to `index.ts` at the package root for a cleaner npm package name display in Pi.

## [0.1.1] - 2025

### Fixed

- Fixed extension identifier to use the package name instead of `package:file`.

## [0.1.0] - 2025

### Added

- Initial release.
- `codex_generate_image` Pi extension using the OpenAI Codex ChatGPT backend (`gpt-image-2`). Piggybacks on Pi's `openai-codex` login — no `OPENAI_API_KEY` required.
- `skills/imagegen` Pi skill with prompting playbook, chroma-key transparency workflow, and Python CLI fallback (`image_gen.py`).
- Save-mode configuration (`none`, `project`, `global`, `custom`) with env and config-file overrides.
- SSE stream parsing with exponential backoff retry on transient errors.
