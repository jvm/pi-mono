# pi-openai-reasoning

Change reasoning effort in long Codex conversations without changing the original
request effort and needlessly invalidating its cached prefix.

- Uses Pi's existing thinking controls. No new command or provider.
- Keeps effort updates at stable positions across retries, resume, forks and trees.
- Works alone, or with `pi-fast` and `pi-codex-tools`.

## Installation

Requires Pi 1.5.2 and an existing Pi `openai-codex` OAuth login.

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
| `openai-codex` / `openai-codex-responses` | Legacy Codex OAuth; `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, standard single-agent, supported efforts below | Cache-preserving updates; subscription usage, no API-key fallback |
| `openai-codex` / `openai-codex-responses` | Other models, such as `gpt-6-sol`, `gpt-6-luna`, GPT-5.6 | Unchanged unless opted in with `models.json` (below) |
| `openai` / `openai-responses` | ChatGPT sign-in or API key; any model | Unchanged; Pi itself sends updates for GPT-6 with an API key |
| Other providers, Pro or multi-agent requests | Any | Unchanged; no inferred protocol support |

Pi labels `openai-codex` **OpenAI Codex**. Signing in with ChatGPT on
`openai` does not enable this extension. Pi's per-thinking-level sampling settings
change ordinary request parameters; they do not implement the pinned request
effort and history-positioned `configuration_update` protocol.

Enabled models are the Codex models that the upstream Codex client's catalog
marks with `supports_reasoning_effort_updates` (checked at
[`openai/codex@32234dd`](https://github.com/openai/codex/blob/32234ddac478f362ef12f3bf3c26d1861ea54b4a/codex-rs/models-manager/models.json)):
`gpt-6-astra`, `gpt-6.1-sol` and `gpt-6.1-terra`, standard single-agent
Responses, with `low`, `medium`, `high`, `xhigh` or `max` effort. Only Astra is
verified by this package's live smoke test; GPT-6.1 Sol and Terra follow the
upstream client and are **not yet verified against the live backend**. The same
catalog marks `gpt-6-sol`, `gpt-6-luna` and GPT-5.6 as not supporting updates,
so they keep Pi's ordinary request effort.

Thinking `off` (effort `none`, for example on GPT-6.1 Terra) is sent as Pi's
ordinary request effort, without an update, like Pi's own public GPT-6
transport. That request does not reuse the cached prefix. The next change after
it uses an update again.

To opt a Codex model in or out, set Pi's documented
`compat.supportsMidConvoEffort` flag in `models.json`. Pi's Codex transport does
not use this flag, so this extension treats it as an explicit override:

```json
{
  "providers": {
    "openai-codex": {
      "modelOverrides": {
        "gpt-6-luna": { "compat": { "supportsMidConvoEffort": true } },
        "gpt-6.1-terra": { "compat": { "supportsMidConvoEffort": false } }
      }
    }
  }
}
```

An opted-in model that the backend does not support can fail requests that
contain an update; remove the override to recover.

Other models/providers,
Pro mode, backend multi-agent requests, server auto-compaction/truncation, stored
conversation references and requests already containing configuration updates are
left unchanged, so an update that Pi or another extension already added is never
duplicated. This package does not add async tools or mid-turn steering.

Virtual-model selections are ineligible even when they dispatch to legacy
Astra. On Pi 1.5.2, request hooks still see the virtual selection; this extension
does not infer physical protocol support from a display name, payload, or prior
response. Pi uses the router's ordinary physical thinking level without this
extension's cache-preserving updates.

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
Pi 1.4's leading inline tool declarations stay in their original positions and
remain fingerprinted; the checkpoint after them is the effort-reset boundary.

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
| GPT-6.1 Sol/Terra reasoning updates on legacy Codex | Enabled because the upstream Codex client catalog marks them `supports_reasoning_effort_updates` and sends updates for them; not yet live-verified by this package. Public model guidance alone is not treated as evidence. Other models need an explicit `models.json` opt-in. |
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

The test uses Astra by default. Set `PI_CODEX_LIVE_MODEL=gpt-6.1-sol` or
`PI_CODEX_LIVE_MODEL=gpt-6.1-terra` to verify a model that is enabled from the
upstream catalog but not yet live-verified.

In the TUI, use the existing thinking selector for low/high, send a short prompt
after each change, then `/compact` and continue. The selector should still show
the effective effort. Print, JSON and RPC requests use the same hooks without UI.

Telemetry is best-effort, once per version, with a five-second timeout.
Disable it with `PI_OFFLINE=1`, `PI_TELEMETRY=0`, or `enableInstallTelemetry: false`.
