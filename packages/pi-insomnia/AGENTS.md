# pi-insomnia Guidelines

Root `AGENTS.md` applies.

## Invariants

- Behavior stays automatic and command-free unless explicitly redesigned.
- Spawn `/usr/bin/caffeinate` directly with fixed arguments; never use shell interpolation.
- Inhibit only during active agent work; release on settle, reload, shutdown, and quit.
- Non-macOS behavior remains a silent no-op.

## Validation

```bash
npm run -w packages/pi-insomnia check
npm test -w packages/pi-insomnia
npm run -w packages/pi-insomnia pack:dry-run
```
