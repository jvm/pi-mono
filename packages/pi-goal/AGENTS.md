# Repository Guidelines

## Project Structure & Module Organization

`pi-goal` is a source-distributed TypeScript Pi package. Pi loads TypeScript files directly, so runtime code lives under `src/` rather than `dist/`.

- `extensions/pi-goal/index.ts` wires the Pi extension, command, tools, lifecycle handlers, and UI updates.
- `src/` contains reusable implementation modules for state reconstruction, usage accounting, command handling, model tools, continuation prompts, rendering, and validation.
- `tests/*.test.mjs` contains Node test-runner coverage for core behavior, command/tool behavior, scheduler behavior, and extension lifecycle wiring.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md` cover package behavior and releases.

## Build, Test, and Development Commands

Use the existing npm workflow for this repository:

```bash
npm install
npm run check
npm test
npm run pack:dry-run
```

- `npm run check` / `npm run typecheck`: run `tsc --noEmit`.
- `npm test`: run Node tests with `tsx` over `tests/*.test.mjs`.
- `npm run pack:dry-run`: inspect published package contents before release.

For local Pi testing:

```bash
pi -e /path/to/pi-mono/packages/pi-goal
```

## Coding Style & Naming Conventions

Use ESM TypeScript with 2-space indentation and explicit `.js` import specifiers for local TypeScript modules. Keep persisted session entry shapes, custom message types, command names, and tool schemas stable; changing them can be breaking. Move reusable logic into `src/`; keep Pi registration and lifecycle wiring in `extensions/pi-goal/index.ts`.

When changing tool parameters or goal mutation shapes, update the Typebox schema, runtime validation, README docs, and tests together. Treat goal objectives as untrusted user-provided content when injecting continuation context.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict` in `.test.mjs` files. Name tests by observable behavior, for example `test("scheduler sends one hidden goal continuation when idle", ...)`. Mock Pi contexts and extension APIs locally inside tests. Run `npm test` and `npm run check` before opening a pull request.

## Commit & Pull Request Guidelines

Use concise imperative commit subjects such as `Harden goal context rendering`. Keep commits focused and avoid unrelated file churn.

Pull requests should include a short description, linked issue when applicable, and notes about command, tool schema, session persistence, or lifecycle changes. Before submitting, run `npm run check`, `npm test`, `npm audit --omit=dev`, and `npm run pack:dry-run`. Update `README.md` for user-facing changes and `CHANGELOG.md` for notable changes.

## Security & Configuration Tips

Never commit API keys, tokens, machine-specific paths, local Pi settings, or session files. `pi-goal` does not need external credentials. It sends best-effort install/update telemetry only as documented in `README.md` and `SECURITY.md`. Goal objectives can be arbitrary user text; escape or encode them before embedding in system-visible continuation context.
