# pi-agentsmd Guidelines

Root `AGENTS.md` applies.

## Invariants

- Keep root `index.ts` as re-export; extension wiring stays in `extensions/`, reusable logic in `src/`.
- `/init` must not overwrite `AGENTS.md` without `--force`.
- Preserve Apache-2.0 attribution for Codex-derived prompt content.

## Validation

```bash
npm run -w packages/pi-agentsmd check
npm test -w packages/pi-agentsmd
npm run -w packages/pi-agentsmd pack:dry-run
```

Smoke test: `pi -e packages/pi-agentsmd --print "list your commands"`.
