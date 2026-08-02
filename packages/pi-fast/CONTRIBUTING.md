# Contributing

Thanks for your interest in contributing to `pi-fast`.

## Development setup

```bash
npm install
npm run -w packages/pi-fast check
```

This package is source-distributed: Pi loads the TypeScript extension files directly. There is no build step for runtime use.

## Pull request checklist

Before opening a pull request:

- Run `npm run -w packages/pi-fast check`.
- Run `npm test -w packages/pi-fast`.
- Run `npm audit --omit=dev`.
- Run `npm run -w packages/pi-fast pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-visible behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit API keys, tokens, auth headers, local settings, or provider configuration containing secrets.

## Coding guidelines

- Keep provider/model capability checks explicit and conservative.
- Preserve the off-by-default, session-local behavior.
- Add a regression test when changing request rewriting or toggle state.

## Code of conduct

This project follows the Contributor Covenant Code of Conduct.
