# Contributing

Thanks for your interest in contributing to `pi-scout`.

## Development setup

```bash
npm install
npm run check
```

This package is source-distributed: Pi loads the TypeScript extension files directly. There is no build step for runtime use.

## Local testing

Install this checkout into a temporary Pi project:

```bash
mkdir -p <test-project>
cd <test-project>
pi install -l /path/to/pi-mono/packages/pi-scout
pi
```

For a one-off run without changing settings:

```bash
pi -e /path/to/pi-mono/packages/pi-scout --print "list your tools"
```

## Pull request checklist

For prompt changes, also run the shared real-session contracts from the monorepo root:

```bash
node --import tsx --test tests/structured-prompts.test.mjs
```

These load both Scout and Skillful through Pi's SDK and inspect serialized provider requests and session history. They use disposable profiles, synthetic credentials, temporary reference directories, and mocked provider responses; they do not contact Git remotes, use a live model, or change existing Scout records. Coverage includes stale-reference pruning, section removal, extension load order, explicit prompt overrides, codemode, reload, resume, fork/tree navigation, and providers that collapse system updates.

Before opening a pull request:

- Run `npm run check`.
- Run `npm audit --omit=dev`.
- Run `npm run pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-facing behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit machine-specific paths, API keys, tokens, or provider config containing secrets.

## Coding guidelines

- Keep `extensions/index.ts` focused on Pi extension wiring and move reusable implementation details into `src/`.
- When adding tools, update Typebox schemas, runtime validation, README parameter docs, and tests together.
- Treat config keys, environment variables, and command names as public interface; changes to defaults or precedence are breaking changes.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
