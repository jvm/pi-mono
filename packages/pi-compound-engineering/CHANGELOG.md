# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package version tracks the upstream [`compound-engineering`](https://github.com/EveryInc/compound-engineering-plugin) component version exactly (see `src/ce-version.ts`). The package has **no independent hotfix counter** — a release of `compound-engineering` is a release of `pi-compound-engineering`. Pi-specific divergence notes appear under `## [Unreleased]`.

## [Unreleased]

### Changed

- Added Pi runtime guidance for resolving bundled CE skill resources (for example, `/ce-setup`'s `skills/ce-setup/scripts/check-health`) without rewriting upstream skill content.

## [3.13.0] - 2026-06-15

### Added

- Initial release of `pi-compound-engineering`, mirroring [`compound-engineering-plugin` v3.13.0](https://github.com/EveryInc/compound-engineering-plugin/releases/tag/cli-v3.13.0) for Pi.
- Install-time fetch via `preinstall` + `postinstall` (no third-party content in the npm tarball; CE 3.13.0 skills, agents, references, and assets are generated from the upstream tarball at `pi install` time).
- SHA256-pinned upstream tarball: `scripts/expected-sha256.txt` is the supply-chain guard; mismatches abort the install with the old version untouched.
- 38 skills (e.g. `ce-plan`, `ce-code-review`, `ce-compound`, `ce-brainstorm`, `ce-work`) and 43 agents (e.g. `ce-correctness-reviewer`, `ce-security-reviewer`, `ce-architecture-strategist`) synced from upstream. (Upstream ships 39 skills; `ce-update` is `ce_platforms: [claude]`-only and is excluded for Pi.)
- Pure-Node port of the upstream CE-to-Pi converter (`scripts/converter.mjs`) — no Bun, no npm dependencies at install time.
- `/ce-status` slash command: reports the synced CE version, skill/agent counts, peer-package detection (`pi-subagents`, `pi-ask-user`), and the upstream tag URL.
- One-shot dependency warnings on first `session_start` when `pi-subagents` or `pi-ask-user` is not installed, with the exact `pi install npm:...` command to recover.
- One-shot skipped-postinstall warning when the `skills/` and `agents/` directories are empty or missing (the `--ignore-scripts` failure mode).
- AGENTS.md block (`<!-- BEGIN COMPOUND PI TOOL MAP -->` / `<!-- END COMPOUND PI TOOL MAP -->`) appended on first load; idempotent across reloads and shared with CE's Codex target.
- `npm run verify` structure check: counts (38 skills, 43 agents), representative content, text-transform probes, and version-mismatch detection.

### Notes

- The `subagent` tool requires `pi install npm:pi-subagents`; the `ask_user` tool requires `pi install npm:pi-ask-user`. Skills that need these tools fall back to inline execution and numbered options in chat respectively, so the package is fully usable without them.
- The `tar` binary is required at install time (universally available on macOS, Linux, and WSL). Native Windows is not supported in this release; see `README.md`.
- The package is licensed MIT. The synced content from `compound-engineering-plugin` is also MIT — see `NOTICE` and the generated `THIRD-PARTY-NOTICES` in the install directory for the full attribution inventory.
