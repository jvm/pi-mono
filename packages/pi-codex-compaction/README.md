# pi-codex-compaction

Keep long Pi sessions flowing with **automatic server-side compaction** inside
ordinary OpenAI Responses requests. The server can emit an encrypted checkpoint
and continue inference without Pi stopping for a separate summary request.

- **On by default** for eligible public `openai` GPT-5/GPT-6 requests.
- Uses your existing ChatGPT subscription login or API-key authentication without
  changing providers, models, credentials, or billing mode.
- Preserves Pi's effective tools, streamed text, tool continuations, and Fast tier.
- Saves checkpoints on the session branch for reload and continuation.
- Keeps `/server-compaction off`, manual `/compact`, and Pi's standard compactor
  as recovery options.

Requires **Pi 1.1.0 or later**. The package name is unchanged, but the legacy
`openai-codex` provider is no longer supported.

## Installation

```bash
pi install npm:pi-codex-compaction
```

For local development:

```bash
pi install /path/to/pi-mono/packages/pi-codex-compaction
```

Or load it for one run:

```bash
pi -e /path/to/pi-mono/packages/pi-codex-compaction
```

Pi supplies the host packages through its extension loader; this package does
not install or resolve a separate physical copy of Pi AI. No manual dependency
installation is required. See Pi's [package dependency contract](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/packages.md#declare-dependencies).

Select a GPT-5/GPT-6 model on provider `openai`, API `openai-responses`, at
`https://api.openai.com/v1`. No enable command is needed. A previously saved
`off` setting on the current session branch remains respected.

Load this package **after extensions that transform provider requests**. Pi
orders handlers by extension load order. The compatibility guard cannot prevent
a later extension from adding incompatible fields.

## Controls and thresholds

```text
/server-compaction status
/server-compaction off
/server-compaction on
/server-compaction on 100000
```

Commands persist the mode and optional token threshold on the current session
branch, not in global or project settings. `on` without a number uses the startup
threshold, or the default when none was supplied.

`--server-compaction` defaults to true.
`--server-compaction-threshold 100000` supplies a startup threshold.
Saved command settings take precedence.

The default threshold is 60% of Pi's local trigger
(`contextWindow - reserveTokens`), including per-model reserve overrides. This
is a headroom heuristic, not an OpenAI-prescribed optimal threshold. Explicit
thresholds must be integers of at least 1,000 and below Pi's local trigger.
Invalid or too-late thresholds leave ordinary inference unchanged.

Very small thresholds can compact repeatedly within one response and increase
latency and token use. Do not use the 1,000-token protocol-test threshold for
ordinary long sessions.

## How continuation works

The extension adds
`context_management: [{ type: "compaction", compact_threshold: ... }]`,
`store: false`, and `stream: true` to eligible ordinary requests. It does not
construct a separate compaction request or reconstruct tool declarations.
Pi's actual request retains grammar tools, hidden loadouts, reasoning options,
Fast settings, and declarations carried through `additional_tools`.

Text streams normally. After successful completion, the extension commits a
Pi compaction entry at `turn_end`, before the next assistant response. It stores
the latest encrypted checkpoint and the exact provider output following it.
On subsequent requests, it replaces the readable fallback and the retained
assistant's serialized items with that checkpoint and output suffix. Later
tool results and messages remain.

Before adopting a checkpoint, the extension verifies the retained assistant
through the configured provider's public `streamSimple` / `onPayload` boundary.
This is a local serialization-only operation: it stops before transport, uses no
real credential, blocks fetch, and adds no model request or usage. It does not
import Pi's internal serializers or locate host files on disk. A serialization
failure leaves history intact.

The original transcript stays in the session file. Reload and tree navigation
use the selected branch, not a global cache. Turning the mode off stops requesting
new checkpoints but still replays a compatible saved checkpoint while the
extension remains loaded.

Successful adoption avoids a separate Pi compaction lifecycle, including between
tool continuations. It does **not** promise zero server-side delay or concurrent
inference during the server's compaction pass. It does not set `background: true`.

## Support and recovery

Authentication stays with Pi: `/login openai` with **Sign in with ChatGPT**
uses plan quota; an OpenAI API key uses separate API billing. Neither path
falls back to the other. This is automatic `context_management` in ordinary
`/responses`, not the standalone `/responses/compact` API or the removed private
RemoteCompactionV2 protocol.

| Route | Behavior |
| --- | --- |
| `openai` + `openai-responses`, official endpoint, GPT-5/GPT-6 | Automatic compaction on by default; server/model availability still applies |
| Same route with ChatGPT sign-in | Live checkpoint/replay verified with `gpt-6-astra` |
| Same route with an API key | Mocked contract coverage; no live billing test |
| Legacy `openai-codex`, custom endpoints, other providers, routed model mismatch | Left unchanged; no compaction or auth hooks for those routes |

Virtual-model selections are also ineligible, including when their physical
dispatch returns to the same public OpenAI model. Pi 1.1.0 request hooks expose
the selected virtual model, not a complete physical request/auth identity.
Existing checkpoints use their bounded readable fallback rather than opaque
replay. Pi's ordinary routed context-limit checks and standard compaction remain
available; no checkpoint identity is inferred from the payload's model name.

GPT-6.1 Sol matches the GPT-6 candidate guard, but the existing live replay
evidence is Astra-only. Model eligibility is not proof of account availability.
No default model is changed. See the [provider migration assessment](../pi-openai-reasoning/README.md#provider-migration-assessment)
for the separate reasoning-update limitation.

- Requests with `configuration_update`, `compaction_trigger`, an existing
  `context_management`, stateful continuation, truncation, background processing,
  or enabled multi-agent mode are not opted in.
- Keep Pi's normal automatic compaction enabled. If no checkpoint is adopted,
  its normal threshold and overflow recovery remain available. Manual `/compact`,
  including custom instructions, uses Pi's standard summarizer.
- Failed, cancelled, malformed, oversized, or unsupported output does not
  replace history. An unsuccessful automatic attempt pauses new automatic
  requests until `/server-compaction on` or session reload. The extension does
  not issue an extra paid retry or switch credentials; Pi owns its own retries.
- Adoption supports reasoning, single-text assistant messages, function/custom
  calls, and compaction items. Other output shapes leave history intact.
- Replay requires the same model, endpoint, auth mode, credential and relevant
  headers. Credential rotation, including OAuth refresh, conservatively uses
  the readable excerpt rather than an unverified checkpoint.
- Edits or transforms of the retained assistant prevent stale raw replay. The
  fallback is a bounded excerpt, **not a complete summary**. Edits to history
  already compacted cannot retroactively change an opaque checkpoint.
- Pi cannot measure the opaque checkpoint's token footprint natively. Local
  context estimates are not exact server-context measurements.
- Cache warming is stopped only when the last ordinary request actually enabled
  automatic compaction. Turning the toggle off does not make an already-cached
  automatic request safe to replay; a new ordinary non-automatic request clears
  that restriction. Unrelated providers retain their normal warming behavior.
- Usage stays on the ordinary assistant response and is counted once. Bounded
  success diagnostics stay local; they contain timing and size counters, not
  conversation content.

## Migration from the legacy provider

Legacy RemoteCompactionV2 requests, `chatgpt.com/backend-api` transport, beta
headers, the temporary `pi-ai/compat` serializer, old transport helper exports,
and the `pi-codex-compaction:tools:v1` / `:request:v1` event-bus contracts have
been removed. Fast and grammar integrations now use the ordinary Pi pipeline.

Existing legacy session files are not modified or deleted. Old encrypted
checkpoints are not migrated or replayed across providers; their readable
fallback remains available. Use compatible package versions together.
`pi-fast` and `pi-codex-tools` still support their own legacy-provider use cases;
this change removes only their obsolete direct-compaction adapters.

`pi-openai-reasoning` remains a legacy-provider-only extension. This package
does not migrate it or enable its reasoning-update feature on the public route.
Automatic compaction and histories containing `configuration_update` are
incompatible in the public API.

## Validation and measured results

Tests use real Pi sessions with mocked transport to cover effective loadouts,
streaming, tool continuations, checkpoint ordering, branches, reloads,
cancellation, credential changes, context edits, default-on behavior, and
the standard compaction safety net. The loading regression test packs the actual
npm tarball and loads it outside the checkout with only declared runtime
dependencies—no physical Pi peers. It uses the shipped bundled host's embedded
module mapping, not just the ordinary SDK's filesystem aliases. It checks CLI
flag registration and checkpoint adoption, tool continuation, and reload in
print, JSON, and RPC modes.

A small live subscription test with `gpt-6-astra` verified checkpoint adoption,
replay, and synthetic fact recall. At a deliberately low 1,000-token threshold,
automatic mode used two requests versus four for standard Pi. The first answer
completed sooner, but overall elapsed time and reported token use were higher.
That protocol test did not measure long-session streaming continuity and does
not establish cost or latency savings.

In a checkout, `tests/AUTOMATIC_BENCHMARK.md` contains the measurements, limits,
and Codex source comparison. `tests/benchmark-automatic.mjs` is an explicitly
gated live test and is not run by `npm test`. Live testing requires approval to
consume usage; use synthetic text, not private session history or images.

```bash
npm run -w packages/pi-codex-compaction check
npm test -w packages/pi-codex-compaction
npm run -w packages/pi-codex-compaction pack:dry-run
```

Before releasing, also install the candidate tarball outside the checkout with
host-peer installation suppressed, then load it through the installed Pi CLI.
`pi -ne -e /path/to/installed/package --offline --help` must show both
`--server-compaction` flags without loading errors or host-dependency warnings.
Never add Pi peers to the candidate directory to make this smoke test pass.

For an approved TUI smoke test, cross the configured threshold in a synthetic
session, then check facts from earlier turns and a tool continuation. Check replay
after `/reload`, mode-off, and branch navigation. Successful adoption should
not start Pi's separate compaction lifecycle.

References:

- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [ChatGPT subscription inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Subscription restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Reasoning-update restrictions](https://developers.openai.com/api/docs/guides/deployment-checklist)

Install telemetry is best-effort, once per version. Disable it with
`PI_OFFLINE=1`, `PI_TELEMETRY=0`, or `enableInstallTelemetry: false`.
