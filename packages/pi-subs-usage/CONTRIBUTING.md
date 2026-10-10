# Contributing

Run from the monorepo root:

```bash
npm install
npm run -w packages/pi-subs-usage check
npm test -w packages/pi-subs-usage
npm run -w packages/pi-subs-usage smoke
npm run -w packages/pi-subs-usage pack:dry-run
```

Pi loads the TypeScript source directly; there is no runtime build step.

For each provider change, verify its endpoint and units against first-party
evidence or a pinned reference implementation. Add synthetic parser fixtures and
an entrypoint/credential-boundary regression test. Never record real tokens,
account responses, local paths, or provider settings as fixtures.

Keep usage percentages, monetary balances, credits, and request counts distinct.
Do not infer a quota denominator or reset from session token usage. Do not add
credential fallbacks without an explicit change to the authentication contract.

Update README for user-visible changes, CHANGELOG for release behavior, and
SECURITY for trust-boundary changes. Run `npm run validate` for security-sensitive
changes and inspect packed contents before publication.

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).
