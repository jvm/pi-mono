# Repository Guidelines

## Project Structure & Module Organization

`pi-dcg` is a source-distributed TypeScript Pi extension. Pi loads the TypeScript entry point directly.

- `extensions/index.ts` wires Pi lifecycle, `tool_call`, `user_bash`, and `/dcg` handlers.
- `src/dcg-client.ts` owns bounded child-process execution and hook requests.
- `src/protocol.ts` validates and formats dcg hook responses.
- `src/config.ts` parses bridge environment variables.
- `src/install-telemetry.ts` contains best-effort install/update telemetry.
- `tests/*.test.mjs` cover protocol, process, client, and extension behavior.

## Build, Test, and Development Commands

Use npm from the monorepo root:

```bash
npm install
npm run -w packages/pi-dcg check
npm run -w packages/pi-dcg test
npm run -w packages/pi-dcg pack:dry-run
```

For a local Pi smoke test:

```bash
pi -e /path/to/pi-mono/packages/pi-dcg
```

## Coding Style & Invariants

Use ESM TypeScript, 2-space indentation, and explicit `.js` specifiers for local imports.

Security-critical invariants:

- Never pass command text through a shell when invoking dcg.
- Always run dcg in Pi's current working directory.
- Keep stdout/stderr and user-visible denial output bounded.
- Treat unknown or malformed hook decisions as bridge errors, never implicit allows.
- A dcg `deny` must remain a block; only dcg `ask` may open a Pi confirmation dialog.
- A cancelled check must block the associated command even in fail-open mode.
- Do not add one-click permanent allowlisting or an LLM-callable bypass tool.
- Do not log command text, dcg stderr, environment contents, or policy files.
- Keep `DCG_NO_SELF_HEAL=1` scoped to dcg child processes so Pi checks cannot rewrite Claude settings.

Keep `extensions/index.ts` focused on event wiring. Put reusable process/protocol behavior under `src/` and dependency-inject it for tests.

## Testing Guidelines

Every decision or process change needs tests for safe, denied, warning, malformed, timeout/cancel, and configured error-mode behavior as applicable. Tests must use deterministic fake responses or local Node child fixtures; do not require dcg, network access, or user configuration.

Before release, inspect `npm pack --dry-run` and ensure tests, AGENTS.md, and machine-specific files are excluded.

## Documentation and Security

Document changes to environment variables, failure defaults, event coverage, process spawning, telemetry, or command data flow in README and SECURITY. Keep the dcg license boundary explicit: dcg is an external prerequisite and must not be copied or bundled into this MIT package.

## Git

Use concise imperative commit subjects. Keep package code, tests, docs, root package listing, and lockfile changes focused on `pi-dcg`. Do not push unless requested.
