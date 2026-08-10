# pi-fast Guidelines

Root `AGENTS.md` applies.

## Invariants

- Fast mode defaults to disabled unless `pi-fast.enabledByDefault` is explicitly `true` in global Pi settings; command toggles are never persisted.
- Only provider/model pairs known to advertise Fast support may receive a fast-mode request.
- OpenAI Codex Fast mode uses the `priority` service tier, which can increase usage.
- The status indicator must reflect the current model: on, off, or unavailable.
- The extension must not read, log, or persist prompts, credentials, or provider response data.

## Validation

```bash
npm run -w packages/pi-fast check
npm test -w packages/pi-fast
npm run -w packages/pi-fast pack:dry-run
```