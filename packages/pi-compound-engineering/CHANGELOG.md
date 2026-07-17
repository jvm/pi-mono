# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package normally tracks the upstream [`compound-engineering`](https://github.com/EveryInc/compound-engineering-plugin) component version. Pi-specific hotfixes may increment the package patch while retaining the pinned upstream version; see `package.json` → `ceVersion` and `src/ce-version.ts`.

## [Unreleased]

## [3.19.2] - 2026-07-17

### Changed

- Refreshed shared TypeScript and Node development dependencies; runtime behavior and the pinned Compound Engineering v3.19.0 content are unchanged.

## [3.19.1] - 2026-07-12

Mirrors [`compound-engineering-plugin` v3.19.0](https://github.com/EveryInc/compound-engineering-plugin/releases/tag/compound-engineering-v3.19.0) with a Pi-specific npm 12 installation hotfix.

### Changed

- Documented npm 12's dependency-script approval requirement and updated the missing-skills warning with scoped approval and rebuild recovery commands.
- Decoupled the package version from the pinned upstream CE version so install scripts continue to fetch `compound-engineering-v3.19.0` for this hotfix release.

## [3.19.0] - 2026-07-12

Mirrors [`compound-engineering-plugin` v3.19.0](https://github.com/EveryInc/compound-engineering-plugin/releases/tag/compound-engineering-v3.19.0) for Pi.

### Added

- New upstream skills: `ce-pov` for project-grounded verdicts, `ce-explain` for personal learning explainers, and `ce-sweep` for recurring feedback sweeps.
- Upstream workflow improvements across planning, brainstorming, code review, debugging, PR handoff, compounding, product pulse, strategy, and verification evidence.
- Verification of the root-native, skills-only upstream layout, including required new skills, skill-local persona assets, and resource-path resolution.

### Changed

- Updated the SHA256 pin for the `compound-engineering-v3.19.0` tarball and adapted the installer to the upstream root-native layout. The old `cli-v` tag series ended at v3.13.1.
- Updated the Pi adapter to match upstream's skills-only design: 29 skills are installed, while former standalone agents are now loaded as prompt assets under their owning skills.
- Removed the `subagents.agents` manifest registration and clean stale generated agents during upgrade, preventing the retired 43-agent registry from persisting in Pi.
- Retained the Pi-specific resource-path rewrite so bundled references, scripts, and assets resolve from package-installed skills.

## [3.13.1] - 2026-06-22

Mirrors [`compound-engineering-plugin` v3.13.1](https://github.com/EveryInc/compound-engineering-plugin/releases/tag/cli-v3.13.1) for Pi. Upstream 3.13.1 is a single `ce-proof` bugfix (HITL review loop replaced by one-way publish, #957); skill and agent counts are unchanged at 38 and 43.

### Changed

- Updated SHA256 pin (`scripts/expected-sha256.txt`) for the `cli-v3.13.1` upstream tarball.

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
