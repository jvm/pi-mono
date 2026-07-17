# Contributing

Thanks for your interest in contributing to `pi-dcg`.

## Development setup

```bash
npm install
npm run -w packages/pi-dcg check
npm run -w packages/pi-dcg test
```

This package is source-distributed: Pi loads its TypeScript extension files directly. There is no runtime build step.

## Local testing

Install the checkout into a temporary Pi project:

```bash
mkdir -p <test-project>
cd <test-project>
pi install -l /path/to/pi-mono/packages/pi-dcg
pi
```

Run `/dcg` to verify binary discovery. Exercise safe and destructive fixtures only through `dcg test` or a disposable sandbox; do not run genuinely destructive commands to test the bridge.

## Pull request checklist

- Run `npm run -w packages/pi-dcg check`.
- Run `npm run -w packages/pi-dcg test`.
- Run `npm audit --omit=dev`.
- Run `npm run -w packages/pi-dcg pack:dry-run` and inspect included files.
- Update README and SECURITY for behavior, environment, process, or data-flow changes.
- Update CHANGELOG for notable changes.
- Keep examples free of credentials, command secrets, machine-specific paths, and local policy content.

## Coding guidelines

- Keep extension wiring in `extensions/index.ts` and reusable behavior in `src/`.
- Start dcg directly; never interpolate command text into a shell command.
- Preserve hard-deny, cancellation, output-bound, cwd, and child-environment invariants documented in AGENTS.md.
- Treat environment variable names and defaults as public API.
- Keep tests independent of a real dcg installation.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
