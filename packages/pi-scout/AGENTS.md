# pi-scout Guidelines

Root `AGENTS.md` applies.

## Invariants

- Treat registered repositories as read-only references unless user requests mutation.
- Keep clone storage private per user; preserve shallow clone default and atomic state writes.
- Prompt context exposes names and local paths, not origin metadata.
- Prune stale clone records before injecting context.
- Removal of non-temporary user data requires explicit approval.

## Validation

```bash
npm run -w packages/pi-scout check
npm test -w packages/pi-scout
npm run -w packages/pi-scout pack:dry-run
```

Smoke test: `pi -e packages/pi-scout --print "list your tools"`.
