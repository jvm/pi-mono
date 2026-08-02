# Contributing

Thanks for your interest in contributing to `pi-codex-compaction`.

## Development setup

```bash
npm install
npm run -w packages/pi-codex-compaction check
```

This package is source-distributed: Pi loads the TypeScript extension files directly. There is no build step for runtime use.

## Pull request checklist

Before opening a pull request:

- Run `npm run -w packages/pi-codex-compaction check`.
- Run `npm test -w packages/pi-codex-compaction`.
- Run `npm audit --omit=dev`.
- Run `npm run -w packages/pi-codex-compaction pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-visible behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit API keys, tokens, auth headers, local settings, or provider configuration containing secrets.

## Coding guidelines

- Keep the Codex provider/API capability check explicit and future-compatible.
- Preserve current-model compaction, context bounds, cancellation, HTTPS, and standard Pi fallback behavior.
- Add a regression test when changing wire parsing, request construction, checkpoint rehydration, or model-switch fallback behavior.

## Code of conduct

This project follows the Contributor Covenant Code of Conduct.
