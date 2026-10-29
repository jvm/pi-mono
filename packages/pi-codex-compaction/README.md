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

### Codemode and current-host compatibility

Compatibility tests exercise Pi 1.1.0 and 1.4.0 in isolated installations,
including zero-inline-budget discovery, deferred activation, reload and
checkpoint replay. Consumed structured intermediates do not enter conversation
history unless the script prints them. Hidden/model-only tools stay outside
nested discovery.

Pi 1.4 emits chronological `configuration_update` items for reasoning effort.
The adapter preserves exact updates with only `type` and `reasoning.effort`
(`none`, `minimal`, `low`, `medium`, `high`, `xhigh`), including between a
summary and retained assistant output. Unknown configuration remains
unsupported and disables automatic adaptation. No host serializer or private
API is patched.

**Pi 1.4 compatibility:** inline `additional_tools` are adapted automatically.
A stable namespace base keeps tools available during compaction; later inline
updates retain their original positions and preserve cached prefixes. Each
compaction starts a fresh base from Pi's current tool state. There is no
tool-strategy setting or opt-in.

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
orders handlers by extension load order. The compatibility check cannot prevent
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
construct a separate compaction request. Compatible requests retain Pi's grammar
tools, hidden loadouts, reasoning options, and Fast settings.

For Pi 1.4's inline tool declarations, the extension derives the initial visible
function/custom tools from the provider's exact serialization and supplies them
in top-level namespaces, removing that redundant leading declaration from input.
It keeps later `additional_tools` items and all system messages in place.
Later additions and updates to inline-only tools do
not change the top-level base. A changed, removed or hidden base tool starts a
new base with the current effective loadout.

Pi folds the effective tool state into its system checkpoint after compaction.
The next request uses that current state as a new namespace base. Keeping an
older base across checkpoints was tested and rejected: it preserved some cache
but lost an inline-only tool during a later compacted response.

Text streams normally. After successful completion, the extension commits a
Pi compaction entry at `turn_end`, before the next assistant response. It stores
the latest encrypted checkpoint and the exact provider output following it.
On subsequent requests, it replaces the readable fallback and the retained
assistant's serialized items with that checkpoint and output suffix. Later
tool results and messages remain. While automatic adaptation is active, native
inline positions are preserved. When automatic mode is off or adaptation is
unavailable, current leading inline declarations are moved after the checkpoint,
before its output suffix, to repair replay from existing sessions.

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
| `openai` + `openai-responses`, official endpoint, GPT-5/GPT-6 | Automatic compaction on by default, including safely mapped Pi inline declarations |
| Same route with ChatGPT sign-in | Live protocol checks on Astra and Sol; exact-model and repeated-compaction measurements are recorded in the benchmark |
| Same route with an API key | Mocked contract coverage; no live billing test |
| Legacy `openai-codex`, custom endpoints, other providers, routed model mismatch | Left unchanged; no compaction or auth hooks for those routes |

Virtual-model selections are also ineligible, including when their physical
dispatch returns to the same public OpenAI model. Pi 1.1.0 request hooks expose
the selected virtual model, not a complete physical request/auth identity.
Existing checkpoints use their bounded readable fallback rather than opaque
replay. Pi's ordinary routed context-limit checks and standard compaction remain
available; no checkpoint identity is inferred from the payload's model name.

Live checks do not cover every GPT-5/GPT-6 variant.
Model eligibility is not proof of account availability.
No default model is changed. See the [provider migration assessment](../pi-openai-reasoning/README.md#provider-migration-assessment)
for the separate reasoning-update limitation.

- Requests with unmappable inline tools, `configuration_update`, `compaction_trigger`, an existing
  `context_management`, stateful continuation, truncation, background processing,
  or enabled multi-agent mode are not opted in.
- Pi 1.4's inline tools need the automatic namespace base. Inline-only requests
  lost tool access in direct Responses tests without Pi, before client replay.
  Unknown tool shapes, conflicting namespaces, foreign top-level declarations,
  missing effective loadouts, and inputs over 4 MiB leave ordinary inference
  unchanged rather than guessing a tool mapping.
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
- Cache reuse is a measured optimization, not a guarantee. Additive inline
  changes preserve the base; changes to that base or a new compaction epoch can
  invalidate cached prefixes. Stable subsequent requests can reuse cache again.
  The extension preserves Pi's existing affinity/cache fields and does not
  enable explicit-cache options rejected by the tested ChatGPT sign-in route.
- Usage stays on the ordinary assistant response and is counted once. Bounded
  success diagnostics stay local; they contain timing and size counters, not
  conversation content.

### Recovering a session that reports missing tools

Stop an active goal's continuation loop with `/goal pause`, if applicable.
Turning `/server-compaction off` stops new automatic checkpoints, but older
package versions still replay a saved checkpoint with declarations before it;
the command alone does not repair that case.

With the fixed package loaded, compatible saved checkpoints replay with the
current inline tools after the checkpoint. Reload the extension, then test one
harmless tool call before resuming work. Without the fix, start a fresh session
with server compaction off, or navigate to an entry before the faulty checkpoint,
turn server compaction off on that branch, and use standard `/compact`.
Do not delete or edit the original session file.

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

Run the additional **offline** host contracts against an installed
Pi SDK through its public entry point:

```bash
PI_COMPACTION_HOST_ENTRY=/path/to/pi-coding-agent/dist/index.js \
  npm test -w packages/pi-codex-compaction
```

The additional host suites mock all transport. They check native function/grammar declarations,
namespaced calls, calls before and after checkpoints, tool removal/redefinition,
mode-off, reload, branches, codemode-hidden tools, multiple compaction epochs,
cache-prefix stability, user-fact recall and Pi's threshold safety net.
Host suites are skipped by ordinary `npm test` unless the host entry is supplied.
The installed Pi 1.4.0 SDK passed these contracts; the pinned Pi 1.1 baseline
alone does not exercise its native inline serializer.

Earlier subscription comparisons reproduced inline tool loss and tested
full-snapshot alternatives. The selected implementation instead keeps native
system/tool history intact and preserves a stable namespace base between
checkpoints. The comparison harness retains rejected alternatives for research;
the published extension has one automatic implementation. Measurements in
`tests/AUTOMATIC_BENCHMARK.md` distinguish cache gains from unavoidable resets
and do not claim a globally optimal cost or latency result.

Before releasing, also install the candidate tarball outside the checkout with
host-peer installation suppressed, then load it through the installed Pi CLI.
`pi -ne -e /path/to/installed/package --offline --help` must show both
`--server-compaction` flags without loading errors or host-dependency warnings.
Never add Pi peers to the candidate directory to make this smoke test pass.

For an approved TUI smoke test, cross the configured threshold in a synthetic
session, then check facts from earlier turns and a tool continuation. Check replay
after `/reload`, mode-off, and branch navigation. Successful adoption should
not start Pi's separate compaction lifecycle.

For Pi 1.4's inline-tool route, check a harmless tool call in a fresh synthetic
session, after several server checkpoints, and after reloading a saved checkpoint.
Automatic mode must promote the leading namespace base without moving later inline updates.
With automatic mode off, leading declarations must follow the saved checkpoint.
Tool results must remain after their calls. Keep standard Pi compaction enabled.
Use the actual installed host for this smoke test, not only the pinned development
SDK: their tool serialization differs.

References:

- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [ChatGPT subscription inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Subscription restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Reasoning-update restrictions](https://developers.openai.com/api/docs/guides/deployment-checklist)

Install telemetry is best-effort, once per version. Disable it with
`PI_OFFLINE=1`, `PI_TELEMETRY=0`, or `enableInstallTelemetry: false`.
