# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

### Added

- PTC availability gate (`resolvePtcAvailability`) with the live-probe verdict:
  the Codex backend rejects `programmatic_tool_calling` (verified 2026-09-04);
  PTC is reported as unavailable on non-API-key sessions, and `/gpt5` shows
  the active blocker per session.
- Core pack: `before_provider_request` payload shaping for GPT-5.x models —
  `reasoning.mode: "pro"`, `reasoning.context` pin, `text.verbosity` pin, and
  image `detail` pin with `original` → `high` clamping off GPT-5.6.
- `/gpt5` subcommands: `pro`, `context`, `verbosity`, `detail`, `status`;
  session-local toggles with TUI status indicator and auth-kind-aware pro-mode
  entitlement (`resolveProModeEntitlement`).
- `features_gate.md`: per-model feature availability reference for OpenAI
  GPT-5.x models, mirrored by `src/features.ts`, including the verified
  catalog-schema note on pro-mode entitlement.

## [0.1.0] - 2026-09-04

- Initial scaffold: package contract, install telemetry, and `/gpt5` feature
  report command.
- `features_gate.md`: per-model feature availability reference for OpenAI
  GPT-5.x models, mirrored by `src/features.ts`.
- Model gates for gpt-5.6 (sol/terra/luna), 5.5, 5.4, 5.3, 5.2, 5.1, and the
  original gpt-5 family, plus legacy Pro slugs.
- Planned: pro mode, persisted reasoning, explicit prompt caching, Programmatic
  Tool Calling, and the multi-agent beta.
