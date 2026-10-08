# pi-openai-reasoning

Change reasoning effort in long Codex conversations without changing the original
request effort and needlessly invalidating its cached prefix.

- Uses Pi's existing thinking controls. No new command or provider.
- Keeps effort updates at stable positions across retries, resume, forks and trees.
- Works alone, or with `pi-fast` and `pi-codex-tools`.

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

| Provider / API | Authentication and model | Behavior / fallback |
| --- | --- | --- |
| `openai-codex` / `openai-codex-responses` | Legacy Codex OAuth; `gpt-6-astra`, standard single-agent, supported efforts below | Cache-preserving updates; subscription usage, no API-key fallback |
| `openai` / `openai-responses` | ChatGPT sign-in or API key; any model | Unchanged Pi thinking controls; no updates from this extension |
| Other providers, GPT-6.1 Sol, Pro or multi-agent requests | Any | Unchanged; no inferred protocol support |

Pi labels `openai-codex` **OpenAI Codex (legacy)**. Signing in with ChatGPT on
`openai` does not enable this extension. Pi's per-thinking-level sampling settings
change ordinary request parameters; they do not implement the pinned request
effort and history-positioned `configuration_update` protocol.

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
the saved pin.

Current `pi-codex-compaction` releases target only the public `openai` route and
no longer provide legacy RemoteCompactionV2 or its event-bus adapters. This
reasoning extension remains legacy-provider-only and is inactive on that public
route. On its supported legacy route, manual compaction uses Pi's standard
summarizer. This change does not migrate the reasoning-update feature.

If history changes outside normal append/branch/compaction operations, the package
starts a new baseline rather than placing an update at an unchecked position.
It stops rewriting above 20,000 input items, 16 MiB of serialized history or 128
effort changes in a context window. The byte budget is checked during JSON
serialization, including within individual input items. Pi's normal effort
handling then remains in use. This can reduce cache reuse; no cache-hit or cost
saving is guaranteed.
Uninstalling the package leaves normal Pi messages and thinking settings intact.

## Protocol reference

### Provider migration assessment

The following decisions describe the current source and checked provider
documentation, not new transport support:

| Capability | Decision and evidence |
| --- | --- |
| Fast on public OpenAI with API key or ChatGPT login | Already supported by `pi-fast`; tier selection is authentication-specific. Mocked transport tests cover both; historical subscription probes establish acceptance, not delivered speed or billing. |
| Public automatic compaction | Implemented separately in PR #174. The [compaction guide](https://developers.openai.com/api/docs/guides/compaction) distinguishes ordinary `context_management` from standalone `/responses/compact`. Existing live replay evidence is Astra-only. |
| Public cache-preserving reasoning updates | Separately implementable candidate, **not enabled here**. The [deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist) documents standard single-agent GPT-6 updates, but forbids combining them with automatic compaction/truncation and rejects them in `/responses/compact` histories. A follow-up needs explicit compaction policy, transport/auth coverage, and approval; merely widening the provider guard is not sufficient. |
| GPT-6.1 Sol reasoning updates on legacy Codex | Unverified; retain Astra-only support. Public model guidance is not evidence for a private backend protocol. No new model default or allowlist expansion. |
| Images through public ChatGPT plan-sharing token | Unsupported by the [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Keep independent `codex-images` login; never copy the chat token to the private image backend. |
| Native image-provider integration | Separate #169 investigation; not required for existing image OAuth. A new adapter requires verified host/API support and must preserve credentials, quota, and no automatic API-billing fallback. |

Documentation does not certify account entitlement, successful execution on
untested models, cache savings, or an equivalent quota multiplier across routes.
New live probes require usage approval. Working legacy reasoning/image paths are
not retired by this assessment.

The implementation is original Pi code. It was informed by read-only study of
`openai/codex` commit `654b0a77d0d2f81aa21f61caf7af4be88fe550bb` (2026-09-11):
`core/src/session/reasoning_effort.rs`, its tests, and RemoteCompactionV2.
No Codex code is copied or vendored.

The Codex backend accepted Astra `configuration_update` values through `max` in
live subscription probes on 2026-09-11 without additional beta headers. The
then-current combined Fast + grammar + reasoning + remote-compaction smoke test also passed:
the continuation recalled the test word, and Pi recorded compaction usage.
That is historical evidence for the removed integration; the current smoke test
uses standard Pi compaction instead. Public
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
