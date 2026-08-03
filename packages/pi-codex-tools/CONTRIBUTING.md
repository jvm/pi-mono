# Contributing

Thanks for your interest in contributing to `pi-codex-tools`.

## Development setup

```bash
npm install
npm run -w packages/pi-codex-tools check
```

This package is source-distributed: Pi loads the TypeScript extension files directly. There is no build step for runtime use.

## Pull request checklist

Before opening a pull request:

- Run `npm run -w packages/pi-codex-tools check`.
- Run `npm test -w packages/pi-codex-tools`.
- Run `npm audit --omit=dev`.
- Run `npm run -w packages/pi-codex-tools pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-visible behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit API keys, tokens, auth headers, local settings, or provider configuration containing secrets.

## Coding guidelines

- Keep model capability checks explicit and conservative; never switch on model names alone.
- Keep raw grammar input separate from JSON tool arguments.
- Add regression coverage for parser, path-safety, mutation, or model-switching changes.
- Preserve OpenAI Codex attribution when changing adapted parser or grammar behavior.

## Code of conduct

This project follows the Contributor Covenant Code of Conduct.
