# Contributing

Thanks for your interest in contributing to `pi-web-kit`.

## Development setup

```bash
npm install
npm run check
npm test
```

This package is source-distributed: Pi loads the TypeScript extension files directly. There is no build step for runtime use.

## Local testing

Install this checkout into a temporary Pi project:

```bash
mkdir -p <test-project>
cd <test-project>
pi install -l /path/to/pi-mono/packages/pi-web-kit
pi
```

For a one-off run without changing settings:

```bash
pi -e /path/to/pi-mono/packages/pi-web-kit --web-provider-fetch markdown_new --print "Fetch https://example.com"
```

## Pull request checklist

Before opening a pull request:

- Run `npm run check`.
- Run `npm test`.
- Run `npm audit --omit=dev`.
- Run `npm run pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-facing behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit machine-specific paths, API keys, tokens, or provider config containing secrets.

## Coding guidelines

- Keep `extensions/index.ts` focused on Pi tool registration and move reusable implementation details into `src/`.
- When changing tool parameters, update the Typebox schema, runtime validation, README parameter docs, and tests together.
- Treat provider names, config keys, env vars, and cache semantics as public interface; changes to defaults or precedence are breaking changes.
- Validate and normalize external URLs before provider calls.
- Bound network work: use shared limits, timeouts, and concurrency helpers for new provider integrations.
- Keep tool `details` compact; full result text belongs in tool content and should remain bounded by `truncateText()`.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
