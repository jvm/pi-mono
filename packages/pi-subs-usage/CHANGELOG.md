# Changelog

## [Unreleased]

## [0.1.0] - 2026-10-10

### Added

- Provider-aware usage status for legacy Codex, Claude, GitHub Copilot, Z.AI/GLM, and OpenCode Go. Hyper is excluded because its provider extension already displays usage.
- Consumed-quota bars, local reset countdowns, and provider-native credit counters. Z.AI global and China show only model-usage quotas, not MCP-tool allowances.
- Compact, prefix-free status grouped in square brackets on Pi's existing extension-status line, without replacing or patching the footer.
- Startup preloading and two-minute background refreshes for all configured supported providers, including inactive accounts and idle sessions. Provider/model switches display cached usage without querying, resolving quota auth, or resetting the polling clock.
- Model-specific quota windows and credential isolation, with identical effective account requests deduplicated per polling cycle.
- `/subs-usage` to refresh all configured supported providers, with session-local on/off controls. Normal refreshes keep cached readings visible; failed reads clear numerical data.
- Temporary native `openai` quota fallback to Pi's `openai-codex` OAuth login, with Pi-managed refresh. Inference authentication remains unchanged; the Codex login may use a different account. Without an eligible fallback, native SIWC shows an explicit unavailable status.
- Exact Pi credential resolution, fixed HTTPS endpoints, official-origin validation, bounded responses, ten-second polling cycles, and cancellation on reload, shutdown, monitoring off, or offline checks.
- Synthetic parser, credential-boundary, background-cache, lifecycle, rendering, and real Pi runtime contract tests.
