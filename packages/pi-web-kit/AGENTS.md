# pi-web-kit Guidelines

Root `AGENTS.md` applies.

## Invariants

- Keep tool schemas, runtime validation, config, docs, and tests synchronized.
- Validate URLs before provider calls; preserve shared limits, timeouts, truncation, and cache scope.
- Never expose API keys or secret-bearing cache keys.
- Project config requires trust. Provider schema changes apply at startup/reload.
- Mock network calls deterministically and restore globals after tests.

## Validation

```bash
npm run -w packages/pi-web-kit check
npm test -w packages/pi-web-kit
npm run -w packages/pi-web-kit pack:dry-run
```

Smoke test affected provider with smallest non-secret configuration.
