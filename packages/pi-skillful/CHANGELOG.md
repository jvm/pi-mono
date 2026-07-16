# Changelog

## 0.3.12 - 2026-07-12

## 0.3.11 - 2026-07-01

## 0.3.9 - 2026-06-14

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

### Fixed

- Ignore project `skillful` settings and block project-scope writes when Pi does not trust the current project.
- Let an explicit project `toggleModifier: "alt"` override a non-default global modifier; unsupported explicit values now follow the documented `"alt"` fallback.
- Consume only configured modifier-slot combinations in the prompt editor instead of registering all 54 possible shortcuts.
- Propagate focus and custom-editor hooks through the session-toggle editor wrapper for IME and extension compatibility.
- Remove the private `InteractiveMode.prototype` startup skill-list patch; visibility now uses only documented Pi APIs.
- Remove the stale package-local `package-lock.json` in favor of the monorepo root lockfile.
- Preserve configured hidden skills at session start. Skillful no longer treats a temporarily incomplete loaded-skill list as authoritative and removes global or project visibility settings.

## [0.3.10] - 2026-07-01

### Fixed

- Color hidden skills in the startup `[Skills]` list on `@earendil-works/pi-coding-agent` 0.80+. The 0.80 release moved the loaded-resources container out of `chatContainer`, so the existing prototype patch walked the wrong container and the red/dim colorization no longer applied. The patch now also walks `loadedResourcesContainer`, where 0.80 actually renders the `[Skills]` section.
- Bumped dev dependency range to `^0.80.0` to match the new floor.

## [0.3.9] - 2026-06-14

### Fixed

- Skipped Pi package-bundled skills when applying hidden-skill and toggle-slot configuration so `skillful` only affects global and project skills.

## [0.3.8] - 2026-06-06

### Changed

- Aligned package structure with monorepo guidelines (added root `index.ts` re-export, `src/index.ts`, fixed extension entry point).
- Update `author` field to full name for monorepo consistency.

## [0.3.7] - 2026-05-20

### Changed

- Moved package source to the `jvm/pi-mono` monorepo.
- Updated npm metadata to point at the monorepo package directory.

## [0.3.6] - 2026-05-12

### Changed

- Made project skill visibility and toggle slots inherit global settings until the project scope is explicitly changed.
- Added `/skillful` menu support for assigning session toggle slots in global or project scope.

## [0.3.5] - 2026-05-12

### Fixed

- Fixed preserving session skill toggle state across `/new` after Pi reloads extension instances.

## [0.3.4] - 2026-05-12

### Changed

- Preserve session skill toggle state across `/new` within the same Pi process.

## [0.3.3] - 2026-05-12

### Fixed

- Fixed session skill toggles so hidden skills toggled active are included in the next system prompt.

## [0.3.2] - 2026-05-10

### Fixed

- Disabled install telemetry reporting when running in CI workflows.

## [0.3.1] - 2026-05-10

### Added

- Install/update telemetry ping to `mocito.dev`, gated by Pi telemetry/offline settings and deduplicated per package version.

## [0.3.0] - 2026-05-09

### Added

- Added session-scoped skill toggle slots with configurable modifier-number shortcuts and prompt-editor top-border status.

## [0.2.4] - 2026-05-09

### Changed

- Switched local development, CI, and publishing workflows from Bun to npm for consistency with Pi package conventions.
- Made the Pi extension entry path explicit as `./extensions/index.ts`.

## [0.2.3] - 2026-05-07

### Fixed

- Flattened extension entry point from `extensions/pi-skillful/index.ts` to `extensions/index.ts` so Pi displays the extension as `pi-skillful` instead of `pi-skillful:pi-skillful` in the startup banner.

## [0.2.2] - 2026-05-07

### Changed

- Migrated peer dependencies from `@mariozechner` to `@earendil-works` scope (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` v0.74.0).

## [0.2.1] - 2026-05-07

### Fixed

- Pruned stale hidden skills from config on session start to avoid referencing removed skills.

## [0.2.0] - 2026-05-07

### Added

- Inline `/skill:name` expansion anywhere in a prompt.
- `/skillful` menu for global/project skill prompt visibility.
- `skillful.hiddenSkills` settings support.
- Startup `[Skills]` list highlights hidden skills in the error color.
