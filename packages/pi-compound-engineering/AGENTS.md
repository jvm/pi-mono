# pi-compound-engineering Guidelines

Root `AGENTS.md` applies.

## Invariants

- Recipe-only package: never commit generated `skills/` or `THIRD-PARTY-NOTICES`.
- Keep preinstall staging and postinstall commit phases separate.
- Install scripts use Node built-ins only; downloaded CE content is never executed.
- Review upstream release, version, expected skill count, and SHA256 together. Never update pin blindly.
- Prefer upstream fixes; converter rewrites only when runtime guidance cannot solve portability.
- Package version may exceed `ceVersion` only for Pi-specific hotfixes.

## Validation

```bash
npm run -w packages/pi-compound-engineering check
npm test -w packages/pi-compound-engineering
npm run -w packages/pi-compound-engineering verify
npm run -w packages/pi-compound-engineering pack:dry-run
```

For pin updates, follow `CONTRIBUTING.md` and verify generated references and attribution.
