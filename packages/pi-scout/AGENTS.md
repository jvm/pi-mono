# Repository Guidelines

## Project Structure & Module Organization

`pi-scout` is a source-distributed TypeScript Pi package. Pi loads TypeScript files directly, so there is no `dist/` build output.

- `index.ts` is the package-level Pi extension entry point for clean startup display names.
- `extensions/index.ts` contains extension wiring.
- `src/index.ts` exports the public package surface.
- Add reusable implementation details under `src/` as the package scope is defined.
- User-facing docs are `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`.

## Build, Test, and Development Commands

Use npm for this package.

- `npm install`: install development dependencies and peer packages.
- `npm run check`: run `tsc --noEmit`; this is the main validation command.
- `npm run typecheck`: alias for the same TypeScript check.
- `npm run pack:dry-run`: preview npm package contents before publishing.

There is no runtime build step. For local Pi testing:

```bash
pi -e /path/to/pi-mono/packages/pi-scout --print "list your tools"
```

## Coding Style & Naming Conventions

Follow `.editorconfig`: UTF-8, LF line endings, final newline, two-space indentation, and trimmed trailing whitespace except in Markdown. Use ESM TypeScript with explicit `.js` import specifiers for local TypeScript modules. Use `camelCase` for functions and variables, `PascalCase` for types/interfaces, and kebab-case for feature files.

Prefer Pi's documented extension APIs over private internals. Move reusable logic into `src/`; keep Pi registration in `extensions/index.ts`, with root `index.ts` only re-exporting the extension.

## Testing Guidelines

There is no dedicated test suite yet. Treat `npm run check` as required before every change. For packaging changes, run `npm run pack:dry-run`. Add tests alongside behavior once `pi-scout` registers tools, commands, or config parsing.

## Commit & Pull Request Guidelines

Use short imperative commit subjects such as `Add scout package scaffold` or `Define scout command`. Keep commits scoped and avoid unrelated file churn.

Before opening a PR, run `npm run check` and `npm run pack:dry-run`. Update `README.md` for user-facing behavior changes and `CHANGELOG.md` for notable changes.

## Security & Configuration Tips

Do not commit credentials, machine-specific paths, or personal Pi settings. If this package later reads local project files or sends data to external services, document the data flow and make configuration explicit before release.
