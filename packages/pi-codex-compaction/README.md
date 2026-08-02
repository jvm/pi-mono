# pi-codex-compaction

Keep long Pi sessions usable on OpenAI Codex models by replacing Pi's local summary request with Codex's provider-side **RemoteCompactionV2** checkpoint when the current model supports the Codex Responses API.

## Features

- Uses the current `openai-codex` model for each compaction; it never silently changes the session model.
- Sends only the history Pi is discarding, plus the previous Codex checkpoint, so the incoming/kept user message is not duplicated.
- Persists Codex's opaque encrypted checkpoint and rehydrates it only for supported Codex requests.
- Caps compaction input and response size and falls back to standard Pi compaction on failure.
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

When Pi starts compaction on a supported Codex model, the extension sends a streamed Responses request containing a `compaction_trigger` item and the `remote_compaction_v2` beta feature. The returned opaque checkpoint is stored in the Pi compaction entry. Later supported Codex requests replace the textual compaction marker with the raw checkpoint; other providers/models receive the bounded textual fallback instead.

Compaction uses the model active when Pi triggers it. If a session switches from a larger to a smaller model, the remote request is bounded against the new model's context window and tool outputs are reduced before sending. If it still cannot fit, the extension leaves compaction to Pi's normal implementation.

If the remote request fails, is cancelled, or returns an unexpected response, Pi's standard compaction path runs. No configuration is required.

## Development

```bash
npm install
npm run -w packages/pi-codex-compaction check
npm test -w packages/pi-codex-compaction
npm run -w packages/pi-codex-compaction pack:dry-run
```
