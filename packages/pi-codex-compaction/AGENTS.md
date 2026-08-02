# pi-codex-compaction Guidelines

Root `AGENTS.md` applies.

## Invariants

- Use Codex RemoteCompactionV2 only for `openai-codex` models using the `openai-codex-responses` API.
- Send the current model's compaction request only the history Pi is discarding, plus the previous opaque Codex checkpoint when one exists; do not duplicate Pi-kept user input.
- Rehydrate opaque `compaction.encrypted_content` only for supported Codex requests. Keep the bounded readable fallback for model/provider switches.
- Bound compaction input and response size, use HTTPS, honor cancellation, and never log prompts, credentials, auth headers, or provider responses.
- Fall back to standard Pi compaction when Codex auth, transport, response shape, or context limits are unavailable.

## Validation

```bash
npm run -w packages/pi-codex-compaction check
npm test -w packages/pi-codex-compaction
npm run -w packages/pi-codex-compaction pack:dry-run
```
