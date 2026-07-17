# Package Guidelines

## Scope

Describe only package architecture, invariants, smoke tests, and exceptions to root `AGENTS.md`.

## Invariants

- List behavior or security contracts agents must preserve.

## Validation

```bash
npm run -w packages/<slug> check
npm test -w packages/<slug>
npm run -w packages/<slug> pack:dry-run
```

Add package-specific smoke tests only when needed.
