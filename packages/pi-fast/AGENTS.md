# pi-fast Guidelines

Root `AGENTS.md` applies.

## Invariants

- Fast mode defaults to disabled unless `pi-fast.enabledByDefault` is explicitly `true` in global Pi settings; command toggles are never persisted.
- Only provider/model pairs known to advertise Fast support may receive a fast-mode request.
- Default to `fast` for OpenAI API keys; use `priority` for ChatGPT OAuth and legacy Codex compatibility.
- Read only Pi's OAuth status to select the tier on each request, including in-stream server compaction; do not cache authentication or probe by retrying rejected requests.
- Support legacy `openai-codex` and `openai` on `openai-responses` with API keys or ChatGPT OAuth.
- Fast requests can increase API charges or subscription usage; an enabled toggle does not guarantee the server delivers Fast processing.
- The status indicator must reflect the current model: on, off, or unavailable.
- The extension must not read, log, or persist prompts, credentials, or provider response data.

## Validation

```bash
npm run -w packages/pi-fast check
npm test -w packages/pi-fast
npm run -w packages/pi-fast pack:dry-run
```
