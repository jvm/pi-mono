# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

### Added

- Reuse the existing clone when `scout_add` receives an already registered source and branch, including equivalent URL, shorthand and local-path spellings. Results add `status: cloned | reused | refreshed`.
- Add `branch` (branch or tag) and `refresh` (fetch and fast-forward an existing clone) to `scout_add`.

### Fixed

- Remove URL credentials, query strings and fragments from persisted records, the `/scout` listing, and the clone's Git `origin` URL; redact records from earlier versions on load.
- Treat `./repo` and `../repo` as local paths instead of GitHub shorthand.
- Disable Git's `ext` transport and interactive credential prompts for Scout Git calls; report timeouts as failures.
- Run SSH in batch mode unless the user configured an SSH command, so Git cannot prompt on Pi's terminal.
- Reject repository sources longer than 4096 characters, and trim trailing separators and dashes in linear time so long runs of `/` or `-` cannot stall validation.
- Cap Git output at 1 MiB per call on Pi hosts with `pi.exec` `maxBuffer`, and run Git in the private clone root instead of the project directory.
- Reject Git remote-helper sources (`<helper>::<address>`, including `ext::` and `fd::`) and unknown URL schemes, which run helper programs and could keep credentials in records; redact credentials inside helper sources stored by earlier versions.
- Store `file://` sources percent-encoded and read `#` and `?` in them literally, as Git does, so a path such as `demo#one.git` keeps its own clone instead of matching `demo`; re-encode records stored unescaped on load.
- Also set `core.askPass=true` on Scout Git calls, so Git versions that ignore `credential.interactive` fail on HTTP authentication instead of prompting on the terminal.

## [0.3.0] - 2026-10-30

### Changed

- Target Pi 1.4.0 for development and contract tests; older hosts are no longer test targets. Pi remains a host-supplied peer dependency.

### Fixed

- Resolve `--scout-context` after native CLI flag initialization so compact context applies on the first prompt and after reload.

### Added

- Add typed `scout_list` with public-field filtering, byte-bounded pages and revision-checked continuation.
- Add opt-in `--scout-context compact`, with full context fallback when listing is inactive.

## [0.2.0] - 2026-10-09

### Added

- Return declared `{ repo }` / `{ removed, deletedClone }` structured results with public repo fields, `scout` namespace discovery, behavior annotations and sequential tool dispatch.

### Changed

- Store reference context in the named `scout_repos` prompt section using Pi's structured API. Remove empty sections, preserve unrelated prompt changes, and leave deliberate full-prompt overrides intact.
- Update the shared Pi development and contract-test baseline to 1.1.0; require Node.js >=22.19.0 to match the host runtime. Pi remains a host-supplied peer dependency.
- Share install telemetry mechanics through `@mocito/install-telemetry` while preserving Pi-specific settings and state paths.

### Fixed

- Keep origin credentials out of tool text/details/results, inferred URL-based names and Git failure diagnostics; terminate Git options before source arguments.
- Preserve removal-tool deactivation across prompts/reload and respect explicit default-tool exclusions during conditional registration.
- Let `enableInstallTelemetry: false` override an enabled `PI_TELEMETRY` environment flag.

## [0.1.4] - 2026-07-17

### Fixed

- Store temporary clones in a private per-user directory and reject unsafe clone roots.
- Serialize repository state mutations and persist state through atomic file replacement.

## [0.1.3] - 2026-07-01

### Changed

- Update Pi core development dependency for Pi 0.80 compatibility.

## [0.1.2] - 2026-06-06

### Changed

- Update `author` field to full name for monorepo consistency.

## [0.1.1] - 2026-05-22

### Added

- Add install/update telemetry ping to `mocito.dev`, gated by Pi telemetry/offline settings and disabled in CI.

## [0.1.0] - 2026-05-21

### Added

- Initial `pi-scout` package scaffold.
- `/scout` command for registering, listing, and removing reference repositories.
- `scout_add` and conditional `scout_rm` tools.
- Compact system prompt injection for registered local repository paths with stale-temp pruning.
- GitHub `owner/repo` shorthand for repository registration.
- `scout_add` tool schema minimized to a single `source` parameter.
- Repository registration now defaults to shallow clones with depth `1`.
- Unix-like systems now use `/tmp/pi-scout` for shorter registered paths.
- Package-level extension entry point so Pi displays the extension as `pi-scout` instead of `extensions`/`extension`.
- Optional temporary clone deletion when removing repository records.
