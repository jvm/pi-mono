# Contributing

Thanks for your interest in contributing to `pi-skillful`.

## Development setup

```bash
npm install
npm run check
npm test
```

The package is source-distributed: Pi loads the TypeScript extension files directly. There is no build step for runtime use.

## Local testing

Install this checkout into a temporary Pi project:

```bash
mkdir -p <test-project>
cd <test-project>
pi install -l /path/to/pi-mono/packages/pi-skillful
pi
```

Then run `/skillful` inside Pi.

For a one-off run without changing settings:

```bash
pi -e /path/to/pi-mono/packages/pi-skillful
```

## Pull request checklist

For prompt changes, also run the shared real-session contracts from the monorepo root:

```bash
node --import tsx --test tests/structured-prompts.test.mjs
```

These load both Skillful and Scout through Pi's SDK, inspect serialized provider requests and session history, and exercise the toggle editor wrapper. They use disposable profiles, synthetic credentials, temporary reference directories, and mocked provider responses; they do not use a live model or existing user settings. Coverage includes extension load order, explicit prompt overrides, hidden skill invocation, codemode, reload, resume, fork/tree navigation, and providers that collapse system updates.

Before opening a pull request:

- Run `npm run check`.
- Run `npm test`.
- Run `npm run pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-facing behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit machine-specific paths or credentials.

## Coding guidelines

- Keep extensions small and focused.
- Prefer Pi's documented extension APIs and TUI primitives over private internals.
- Preserve explicit skill invocation even when a skill is hidden from model auto-discovery.
- Be careful when writing project settings. If `.pi/settings.json` would become empty after removing `skillful`, delete it instead.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
## Pi 1.1.0 terminal audit

From the monorepo root, run `node --import tsx --test tests/tui-contracts.test.mjs`
alongside the package tests. `tests/TUI_AUDIT.md` records coverage, known host
limitations, and the disposable-profile physical-terminal acceptance procedure.
The startup patch remains isolated; no unreleased cursor API is required.
