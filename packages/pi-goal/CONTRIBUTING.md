# Contributing

Thanks for your interest in contributing to `pi-goal`.

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
pi install -l /path/to/pi-mono/packages/pi-goal
pi
```

For a one-off run without changing settings:

```bash
pi -e /path/to/pi-mono/packages/pi-goal
```

## Pull request checklist

Before opening a pull request:

- Run `npm run check`.
- Run `npm test`.
- Run `npm audit --omit=dev`.
- Run `npm run pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-facing behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit machine-specific paths, session files, API keys, tokens, or local Pi settings.

## Coding guidelines

- Keep `extensions/index.ts` focused on Pi extension wiring and move reusable implementation details into `src/`.
- When changing model tool parameters, update the Typebox schema, runtime validation, README tool docs, and tests together.
- Treat persisted mutation shapes, custom message types, command names, and tool names as public interface.
- Preserve branch-scoped semantics: reconstruct state from `ctx.sessionManager.getBranch()` and avoid global process state that crosses sessions unexpectedly.
- Bound model-visible context growth; hidden continuation context should stay compact and stale continuation messages should be filtered.
- Treat goal objectives as untrusted user text and encode them before embedding in continuation prompts.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
