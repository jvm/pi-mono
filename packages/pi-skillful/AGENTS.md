# pi-skillful Guidelines

Root `AGENTS.md` applies.

## Invariants

- Hidden skills remain explicitly invokable.
- Package-bundled skills are never hidden or assigned toggle slots.
- Project settings require active trust; global inheritance remains intact.
- Compose editor wrappers with focus, IME, hooks, and previous editor behavior.
- Startup coloring uses private Pi UI API: isolate it and keep integration coverage that fails if patch wiring disappears.

## Validation

```bash
npm run -w packages/pi-skillful check
npm test -w packages/pi-skillful
npm run -w packages/pi-skillful pack:dry-run
```

Smoke test `/skillful`, startup colors, hidden invocation, inline invocation, and configured shortcuts after UI changes.
