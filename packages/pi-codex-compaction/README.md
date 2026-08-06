# pi-codex-compaction

Keep long Pi sessions usable on OpenAI Codex models by replacing Pi's local summary request with Codex's provider-side **RemoteCompactionV2** checkpoint when the current model supports the Codex Responses API.

## Features

- Uses the current `openai-codex` model for each compaction; it never silently changes the session model.
- Sends only the history Pi is discarding, plus the previous Codex checkpoint, so the incoming/kept user message is not duplicated.
- Retains the normal Codex Responses request envelope, including system instructions, active tool schemas, reasoning settings, prompt-cache fields, and routing fields.
- Persists Codex's opaque encrypted checkpoint and rehydrates it only for supported Codex requests.
- Reuses checkpoints only for the same model, trusted endpoint, Codex account, and authentication mode.
- Bounds input with a UTF-8-aware token estimate, trims tool output when necessary, retries transient failures, and honors cancellation.
- Falls back to standard Pi compaction on failure or when custom compaction instructions are requested.
- Keeps a bounded readable transcript excerpt so switching models or providers remains usable.

The current Codex catalog includes models such as `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. Capability detection follows the provider/API contract (`openai-codex` + `openai-codex-responses`) rather than a brittle model-name list.

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

If the remote request fails, is cancelled, or returns an unexpected response, Pi's standard compaction path runs. Custom compaction instructions also use Pi's standard path because RemoteCompactionV2 has no documented custom-instructions field. The direct checkpoint request is restricted to `https://chatgpt.com`, rejects redirects, limits request/response size, and never decodes or logs `encrypted_content`. No configuration is required.

## Development

```bash
npm install
npm run -w packages/pi-codex-compaction check
npm test -w packages/pi-codex-compaction
npm run -w packages/pi-codex-compaction pack:dry-run
```
