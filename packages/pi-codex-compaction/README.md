# pi-codex-compaction

Keep long Pi sessions usable on OpenAI Codex models by replacing Pi's local summary request with Codex's provider-side **RemoteCompactionV2** checkpoint when the current model supports the Codex Responses API.

## Features

- Uses the current `openai-codex` model for each compaction; it never silently changes the session model.
- Sends only the history Pi is discarding, plus the previous Codex checkpoint, so the incoming/kept user message is not duplicated.
- Retains the normal Codex Responses request envelope, including system instructions, active tool schemas, reasoning settings, prompt-cache fields, and routing fields.
- Persists Codex's opaque encrypted checkpoint and rehydrates it only for supported Codex requests.
- Reuses checkpoints only for the same model, trusted endpoint, Codex account, and authentication mode.
- Bounds input with a Codex-style UTF-8 token estimate and a separate hard byte limit, trims tool output when necessary, retries transient failures, and honors cancellation.
- Falls back to standard Pi compaction on failure or when custom compaction instructions are requested.
- Keeps a bounded readable transcript excerpt so switching models or providers remains usable.

The current Codex catalog includes `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. Capability detection follows the provider/API contract (`openai-codex` + `openai-codex-responses`) rather than a brittle model-name list. Use Pi 0.85.1 or later.

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

## Behavior

When Pi starts compaction on a supported Codex model, the extension sends a streamed Responses request whose `input` contains only discardable history, any compatible prior checkpoint, and a `compaction_trigger` item. The normal request envelope is retained because Codex's compaction path is parity-tested against ordinary Responses requests; this includes the effective system prompt, active tool definitions, reasoning level, prompt-cache fields, and routing fields. The request uses the `remote_compaction_v2` beta feature, and the returned opaque checkpoint and bounded provider usage are stored in the Pi compaction entry. Later requests rehydrate the raw checkpoint only when the model, endpoint, account, and authentication mode match; other providers/models receive the bounded textual fallback instead.

Compaction uses the model active when Pi triggers it. If a session switches from a larger to a smaller model, the remote request is bounded against the new model's context window and tool outputs are reduced before sending. A previous opaque checkpoint is treated as incompatible after a model, endpoint, account, or authentication-mode switch; Pi's readable previous summary is sent instead. If the full request still cannot fit, the extension leaves compaction to Pi's normal implementation.

If the remote request fails or returns an unexpected response, Pi's standard compaction path runs. Cancellation remains cancelled. Custom compaction instructions also use Pi's standard path because RemoteCompactionV2 has no documented custom-instructions field. The direct checkpoint request is restricted to `https://chatgpt.com`, rejects redirects, limits request/response size, and never decodes or logs `encrypted_content`. No configuration is required.

### Size limits

Input is estimated as `ceil(UTF-8 request bytes / 4)`, with 8,192 tokens reserved
from the active model's context window. This uses Codex's ordinary-item heuristic,
not an exact tokenizer. The complete transformed request is counted, including
system instructions, tool definitions, and routing fields. Opaque checkpoints
and image data remain counted at their serialized size; they are not decoded or
discounted. Non-ASCII text uses UTF-8 bytes, not JavaScript string length.

The uncompressed request also has an independent **16 MiB hard limit**. Tool
outputs are reduced only when one of these limits is exceeded. User messages,
tool calls, and opaque checkpoints are not removed. If the remaining request
still cannot fit, or the model's context limit is unknown, standard Pi compaction
runs. The estimate can differ from the server's token count; a server rejection
still uses the existing fallback.

### Fallback diagnostics

A fallback on a supported model records a local custom session entry with type
`pi-codex-compaction:fallback:v1`. It contains `version: 1` and a reason:
`custom-instructions`, `auth-unavailable`, `request-unavailable`,
`context-window-unavailable`, `context-limit`, `request-size-limit`, or
`remote-failed`. Size failures also include estimated tokens, token budget,
request bytes, byte limit, and the number of tool outputs reduced.

No prompt, tool content, encrypted checkpoint, account identifier, credential, or
raw provider error is included. These entries are not sent to the model. Pi
shows a warning when UI notifications are available; print/JSON mode gets no
extra console output. Unsupported models and cancelled attempts do not create
fallback diagnostics. Diagnostic storage or notification failure does not stop
the standard compactor.

## Development

### Other Codex extensions

With `pi-fast` installed, direct compaction requests use the current Fast toggle.
With `pi-codex-tools` installed, `apply_patch` keeps its raw grammar definition,
custom-tool calls, and custom-tool results during compaction. Neither package is
required. No package reads a private Pi tool registry.
With `pi-openai-reasoning` installed, verified Astra requests keep the original
request effort and receive the current effort as a configuration update.
Failed compaction does not change saved reasoning state.

Pi 0.85.1 does not expose grammar metadata in `getAllTools()`. Two synchronous,
versioned `pi.events` contracts let cooperating extensions supply it:

- `pi-codex-compaction:tools:v1`: `{ model, tools }`, before provider serialization.
  A tool owner can attach its own `constrainedSampling` metadata.
- `pi-codex-compaction:request:v1`: `{ ctx, messages, payload }`, after input
  assembly and before size checks. A listener can replace `payload`. This event
  is not the general `before_provider_request` chain and does not carry auth.

Other extensions' private request changes are not applied automatically.
Unknown third-party grammar metadata needs cooperation through the tools event.
The checkpoint entry includes standard Pi `usage`, including cache reads and
cache writes, as well as the original bounded token counters in `details`.
Costs follow Pi's catalog estimates. They are not a ChatGPT subscription bill.

### Reference and smoke test

Behavior was checked against `openai/codex` commit
`654b0a77d0d2f81aa21f61caf7af4be88fe550bb` (2026-09-11), notably
`core/src/compact_remote_v2{,_attempt}.rs`. No Codex code was copied.
RemoteCompactionV2 is a changing Codex protocol, not the public `/responses/compact`
API. Async tools and mid-turn steering require upstream Pi support.

For a small live test, load this package and select `openai-codex/gpt-6-astra`.
Send two short messages, run `/compact`, then ask about the first message.
Repeat with `/fast on` and `pi-codex-tools` loaded. Check that compaction succeeds,
the continuation retains context, and session usage includes compaction tokens.
Use only a temporary file if you test `apply_patch`. Do not generate images.

```bash
npm install
npm run -w packages/pi-codex-compaction check
npm test -w packages/pi-codex-compaction
npm run -w packages/pi-codex-compaction pack:dry-run
```
