# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

### Added

- Initial scaffold: package contract, install telemetry, `/gpt5` feature report
  command, and the `features_gate.md` gating reference mirrored by
  `src/features.ts`.

## [0.1.0] - 2026-09-04

- Initial scaffold: package contract, install telemetry, and `/gpt5` feature
  report command.
- `features_gate.md`: per-model feature availability reference for OpenAI
  GPT-5.x models, mirrored by `src/features.ts`.
- Model gates for gpt-5.6 (sol/terra/luna), 5.5, 5.4, 5.3, 5.2, 5.1, and the
  original gpt-5 family, plus legacy Pro slugs.
- Planned: pro mode, persisted reasoning, explicit prompt caching, Programmatic
  Tool Calling, and the multi-agent beta.
