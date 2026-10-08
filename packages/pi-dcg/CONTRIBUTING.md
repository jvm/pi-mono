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

### Automated session and TUI smoke tests

From the repository root:

```bash
npm run -w packages/pi-dcg test
node --import tsx --test packages/pi-dcg/tests/ui-contract.test.mjs
```

The second command is the focused TUI smoke test. It drives Pi's actual selector rendering and keyboard handlers, plus the `!`/`!!` entry point, with a mock terminal. Every profile is temporary; provider requests, DCG process responses, and shell execution are mocked. No real credentials, user policy files, live model requests, or destructive commands are needed.

The session tests use the real extension factory, `DcgClient` parser, loader, event runner, tool registry, and codemode. A negative control without DCG proves that the shell-execution spy can be reached. Blocked calls must never reach it. Check nested execution-end events and parent IDs rather than assuming nested calls are transcript entries or that pre-execution blocks emit `tool_result`.

Private TUI method access is confined to `tests/ui-contract.test.mjs`; production code uses public extension APIs. These tests do not simulate every terminal emulator. For terminal-specific failures, use a disposable profile and harmless commands, confirm that parallel DCG prompts appear one at a time, then interrupt a pending prompt and check that it disappears without execution. Never change your normal Pi settings to perform the smoke test.

### Upstream follow-ups from #166

Pi 1.1.0 can detach `tool_call` event input from the actual execution arguments when an earlier handler replaces the object. It also lacks a shared queue for concurrent dialogs from different extensions. The tests that name these limitations deliberately characterize the current behavior; they do not certify it as safe.

An upstream fix should preserve input identity from the start of dispatch and coordinate terminal dialogs across extensions. Do not patch installed Pi files, replace bash, or weaken DCG policy to hide these gaps. When the host fixes them, update the shared baseline and replace the characterization assertions with the desired guarantees. Do not treat the local #166 work as closing those upstream requirements.

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
