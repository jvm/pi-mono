# pi-openai-reasoning

Change reasoning effort in long Codex conversations without changing the original
request effort and needlessly invalidating its cached prefix.

- Uses Pi's existing thinking controls. No new command or provider.
- Keeps effort updates at stable positions across retries, resume, forks and trees.
- Works alone, or with `pi-fast`, `pi-codex-tools` and `pi-codex-compaction`.

## Installation

Requires Pi 0.85.1 or later and an existing Pi `openai-codex` OAuth login.

```bash
pi install npm:pi-openai-reasoning
```

For local development:

```bash
pi -e /path/to/pi-mono/packages/pi-openai-reasoning
```

Installing the package enables this behavior for supported requests. It does not
change your selected effort. Use Pi's thinking selector or SDK `setThinkingLevel`.
There is no public OpenAI API support in this first version and no API-key fallback.

## Support and limits

The verified model is `openai-codex/gpt-6-astra`, standard single-agent Responses,
with `low`, `medium`, `high`, `xhigh` or `max` effort. Other models/providers,
Pro mode, backend multi-agent requests, server auto-compaction/truncation, stored
conversation references and requests already containing configuration updates are
left unchanged. This package does not add async tools or mid-turn steering.

The first request pins the effort for its current context window. Later changes
use `configuration_update` input items before new user input, or after tool
history when no new user input exists. All other request fields remain intact.
An identical retry retains its previous selection, even if the thinking selector
changed meanwhile. The change applies when history advances.

State is reconstructed from the active session branch on every request. It stores
efforts, item positions and SHA-256 history fingerprints, not duplicate prompts.
After successful compaction, a new request baseline and an explicit effort update
after the checkpoint restore the selected effort. Failed compaction cannot change
the saved pin. With `pi-codex-compaction`, direct checkpoint requests also receive
the current settings through its versioned public event bus.

If history changes outside normal append/branch/compaction operations, the package
starts a new baseline rather than placing an update at an unchecked position.
It stops rewriting above 20,000 input items, 16 MiB of serialized history or 128
effort changes in a context window. Pi's normal effort handling then remains in
use. This can reduce cache reuse; no cache-hit or cost saving is guaranteed.
Uninstalling the package leaves normal Pi messages and thinking settings intact.

## Protocol reference

The implementation is original Pi code. It was informed by read-only study of
`openai/codex` commit `654b0a77d0d2f81aa21f61caf7af4be88fe550bb` (2026-09-11):
`core/src/session/reasoning_effort.rs`, its tests, and RemoteCompactionV2.
No Codex code is copied or vendored.

The Codex backend accepted Astra `configuration_update` values through `max` in
live subscription probes on 2026-09-11 without additional beta headers. The
combined Fast + grammar + reasoning + remote-compaction smoke test also passed:
the continuation recalled the test word, and Pi recorded compaction usage. Public
[reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning)
describes the input shape, but is not treated as proof of Codex support.

## Development and smoke test

```bash
npm run -w packages/pi-openai-reasoning check
npm test -w packages/pi-openai-reasoning
npm run -w packages/pi-openai-reasoning pack:dry-run
```

Tests mock network access. The separate live smoke test uses your existing Codex
subscription and consumes usage. It sends short text prompts, changes effort,
compacts and checks continuation. It never generates images.

```bash
PI_CODEX_LIVE_SMOKE=1 PI_TELEMETRY=0 npm run -w packages/pi-openai-reasoning smoke:live
```

In the TUI, use the existing thinking selector for low/high, send a short prompt
after each change, then `/compact` and continue. The selector should still show
the effective effort. Print, JSON and RPC requests use the same hooks without UI.

Telemetry is best-effort, once per version, with a five-second timeout.
Disable it with `PI_OFFLINE=1`, `PI_TELEMETRY=0`, or `enableInstallTelemetry: false`.
