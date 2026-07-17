# pi-dcg Guidelines

Root `AGENTS.md` applies.

## Invariants

- Never invoke dcg through a shell; run in Pi cwd with bounded output.
- Unknown/malformed decisions are bridge errors. Cancellation always blocks.
- `deny` always blocks; only `ask` may prompt. Never add model-callable bypasses.
- Seal approved command against later handler mutation.
- Never log commands, dcg stderr, environment, or policy files.
- Keep `DCG_NO_SELF_HEAL=1` child-scoped.

## Validation

```bash
npm run -w packages/pi-dcg check
npm test -w packages/pi-dcg
npm run -w packages/pi-dcg pack:dry-run
```

Decision/process changes test allow, deny, ask, malformed, timeout/cancel, and failure posture as applicable. Update README and SECURITY for command-flow changes.
