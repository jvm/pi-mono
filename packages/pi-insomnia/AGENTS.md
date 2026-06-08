# Repository Guidelines

## Project Structure & Module Organization

`pi-insomnia` is a source-distributed TypeScript Pi package. Pi loads TypeScript files directly, so runtime code lives under `src/` rather than `dist/`.

- `extensions/index.ts` wires the Pi extension lifecycle handlers.
- `src/sleep-inhibitor.ts` contains the macOS sleep-inhibition implementation.
- `src/install-telemetry.ts` contains best-effort install/update telemetry.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md` cover package behavior and releases.

## Build, Test, and Development Commands

Use the existing npm workflow for this repository:

```bash
npm install
npm run check
npm run pack:dry-run
```

- `npm run check` / `npm run typecheck`: run `tsc --noEmit`.
- `npm run pack:dry-run`: inspect published package contents before release.

For local Pi testing:

```bash
pi -e /path/to/pi-mono/packages/pi-insomnia
```

## Coding Style & Naming Conventions

Use ESM TypeScript with 2-space indentation and explicit `.js` import specifiers for local TypeScript modules. Keep `extensions/index.ts` focused on Pi lifecycle wiring. Move reusable behavior into `src/`.

The default behavior is intentionally command-free: installing the package should automatically inhibit macOS idle sleep while the agent is working. Do not add slash commands, tools, or prompts unless explicitly required.

## Testing Guidelines

This package currently relies on TypeScript checking and local Pi smoke testing. If behavior grows, add Node test-runner coverage under `tests/*.test.mjs` and update `package.json` scripts and `tsconfig.json` includes together.

## Commit & Pull Request Guidelines

Use concise imperative commit subjects such as `Add macOS sleep inhibitor`. Keep commits focused and avoid unrelated file churn.

Pull requests should include a short description, linked issue when applicable, and notes about lifecycle or platform-behavior changes. Before submitting, run `npm run check`, `npm audit --omit=dev`, and `npm run pack:dry-run`. Update `README.md` for user-facing changes and `CHANGELOG.md` for notable changes.

## Security & Configuration Tips

Never commit API keys, tokens, machine-specific paths, local Pi settings, or session files. `pi-insomnia` does not need external credentials. It starts `/usr/bin/caffeinate` directly with fixed arguments on macOS; avoid introducing shell interpolation around helper execution.
