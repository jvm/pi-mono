# pi-goal Guidelines

Root `AGENTS.md` applies.

## Invariants

- Persist goal mutations as immutable branch entries; preserve tree/fork/reload reconstruction.
- Keep command names, entry/message shapes, tool schemas, and status transitions stable.
- `complete` needs requirement evidence; `blocked` needs repeated blocker evidence.
- Treat objectives as untrusted text when injecting continuation context.
- Automatic continuation must stop for pending user work, terminal states, budgets, and provider limits.

## Validation

```bash
npm run -w packages/pi-goal check
npm test -w packages/pi-goal
npm run -w packages/pi-goal pack:dry-run
```

Test scheduler and lifecycle wiring for persistence or continuation changes.
