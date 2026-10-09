# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

### Fixed

- Load managed npm installations without a physical Pi AI dependency. Remove host filesystem resolution and internal serializer imports; verify retained output through the configured provider's public serialization boundary with transport disabled.
- Test the actual packed entry outside the checkout without installing or linking Pi peers, including CLI startup and checkpoint/tool continuation/reload in print, JSON, and RPC modes.

## [0.2.2] - 2026-10-09

### Fixed

- Keep Pi AI exclusively as a host-supplied peer dependency to avoid extension-loader warnings and duplicate runtime modules.

## [0.2.1] - 2026-10-09

### Fixed

- Resolve Pi AI helpers relative to its root entry to avoid Pi's extension-loader alias rewriting submodule imports into invalid paths. Include Pi AI as a runtime dependency and test loading outside the monorepo.

## [0.2.0] - 2026-10-09

### Added

- Default-on automatic server-side compaction for eligible public OpenAI Responses requests, including ChatGPT subscription authentication. Keep `/server-compaction off`, persisted overrides, and optional thresholds.
- Commit streamed checkpoints through Pi's public turn-end boundary and replay the latest checkpoint plus its exact output suffix, including mid-response checkpoints and tool continuations.
- Bound checkpoint storage, bind replay to the model and credential, preserve readable fallbacks and normal Pi compaction, and avoid counting ordinary response usage twice.
- Add real-session regression coverage and an explicitly gated, synthetic-text subscription comparison. The small live Astra trial verified replay but did not demonstrate lower total latency or token use than standard Pi compaction.
- Verify immediate text streaming and tool continuation without a second Pi compaction when its safety net is enabled. Add flow-timing instrumentation to the gated benchmark; the earlier live trial did not measure streaming gaps.

### Changed

- Clarify provider/auth billing boundaries and distinguish automatic public compaction from standalone `/responses/compact` and removed RemoteCompactionV2.

- Require Pi 1.1.0 or later for the public turn-end boundary and normalized-transcript APIs.
- Scope cache-warming interception to the actual automatic-compaction request instead of a global enabled toggle.
- Update the shared Pi development and contract-test baseline to 1.1.0; require Node.js >=22.19.0 to match the host runtime. Pi remains a host-supplied peer dependency.

### Removed

- **Breaking:** Remove legacy `openai-codex` RemoteCompactionV2 support, direct backend transport, beta headers, temporary `pi-ai/compat` serialization, old transport helper exports, legacy TUI confirmations, and direct-compaction event-bus contracts.
- Remove the unused direct `pi-tui` dependency. Existing legacy session files remain untouched, with readable fallback rather than cross-provider opaque replay.

## [0.1.5] - 2026-09-17

### Fixed

- Persist the Codex compaction confirmation as a rendered, non-model session entry so Pi's post-compaction chat rebuild does not erase it.

## [0.1.4] - 2026-09-15

### Added

- Show `[compaction (codex)] Checkpoint saved.` in the TUI after a Codex checkpoint is saved, to distinguish it from standard Pi compaction.

## [0.1.3] - 2026-09-11

### Fixed

- Estimate compaction tokens separately from request bytes so long Codex sessions do not fall back merely because UTF-8 bytes exceed the token budget.
- Respect request-transform field removals when sizing, restrict warnings to TUI mode, and distinguish preparation failures from transport failures.
- Preserve the independent 16 MiB request ceiling, count the complete transformed envelope, and reject unavailable context limits.
- Record safe fallback reasons and numeric size diagnostics in local custom session entries; notify when UI is available without exposing request or provider content.

## [0.1.2] - 2026-09-11

### Fixed

- Preserve pi-codex-tools grammar metadata and custom-tool history during remote compaction.
- Honor pi-fast on direct compaction requests through a public event-bus contract.
- Include cache writes and standard Pi compaction usage in session totals.
- Restrict endpoint paths and ports; merge beta features and honor null auth headers.
- Avoid I/O after pre-cancellation, bound total request time, and close completed SSE streams promptly.

## [0.1.1] - 2026-08-06

### Fixed

- Let `enableInstallTelemetry: false` override an enabled `PI_TELEMETRY` environment flag.
- Keep the normal Codex Responses request envelope while excluding Pi's retained user input from compaction history.
- Avoid reusing opaque checkpoints across model, endpoint, account, or authentication-mode changes.
- Avoid reusing opaque checkpoints when the authentication mode cannot be verified.
- Reject version 1 opaque checkpoints from existing sessions and use readable fallback context until a new checkpoint is created.
- Fall back to Pi's standard compactor when custom compaction instructions are supplied.

### Added

- Incremental bounded SSE parsing, transient request retries, response idle timeouts, provider usage capture, and file-operation fallback metadata.
- Trusted-origin and redirect protections for direct Codex compaction requests.

## [0.1.0] - 2026-08-02

### Added

- Initial `pi-codex-compaction` extension.
- OpenAI Codex RemoteCompactionV2 support with standard Pi compaction fallback.
- Opaque checkpoint persistence and bounded cross-model fallback context.

### Fixed

- Use Pi's compat provider entry point so the extension loads through the runtime extension loader.
- Rehydrate summaries emitted as untyped Responses message items after model switches.
