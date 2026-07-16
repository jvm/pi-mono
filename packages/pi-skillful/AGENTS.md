# Repository Guidelines

## Project Structure & Module Organization

`pi-skillful` is a source-distributed TypeScript Pi package. Pi loads `extensions/index.ts`, which wires together modules in `src/extensions/`. Shared helpers and settings logic live in `src/`, including `src/config.ts` and `src/skills.ts`. Project-local Pi settings may appear in `.pi/`. User-facing docs are `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`. The npm package also includes `banner.png`.

## Build, Test, and Development Commands

Use npm for this repository.

- `npm install`: install development dependencies and peer packages.
- `npm run check`: run `tsc --noEmit`; this is the main validation command.
- `npm run typecheck`: alias for the same TypeScript check.
- `npm test`: compile to `.test-dist` and run the Node test suite.
- `npm run pack:dry-run`: preview the npm package contents before publishing.

There is no runtime build step. For local Pi testing, install this workspace package into a temporary project with `pi install -l /path/to/pi-mono/packages/pi-skillful`, then run `pi` and open `/skillful`.

## Coding Style & Naming Conventions

Follow `.editorconfig`: UTF-8, LF line endings, final newline, two-space indentation, and trimmed trailing whitespace except in Markdown. This is an ESM TypeScript package; keep imports explicit and prefer typed interfaces for settings and Pi API boundaries. Use `camelCase` for functions and variables, `PascalCase` for types/interfaces, and kebab-case for feature files such as `inline-skill-invocation.ts`. Prefer Pi's documented extension APIs and TUI primitives over private internals.

## Testing Guidelines

Run `npm test` and `npm run check` before every change. Tests cover settings precedence, project trust, prompt visibility, dynamic shortcuts, editor composition, and focus propagation. For behavior changes, also smoke test in a temporary Pi project and verify `/skillful`, hidden skill toggling, and inline `/skill:name` expansion. For packaging changes, run `npm run pack:dry-run`.

## Commit & Pull Request Guidelines

Recent history uses short imperative commits, sometimes with `fix:` or `docs:` prefixes. Examples: `Use npm for package workflow`, `fix: flatten extension entry point to fix startup display name`. Keep commits scoped and concise.

Before opening a PR, run `npm run check` and `npm run pack:dry-run`. Update `README.md` for user-facing behavior changes and `CHANGELOG.md` for notable changes. PR descriptions should summarize the change, mention manual Pi testing, link related issues when available, and include screenshots or terminal output only when useful.

## Security & Configuration Tips

Do not commit credentials, machine-specific paths, or personal Pi settings. Global settings live at `~/.pi/agent/settings.json`; project settings live at `.pi/settings.json`. Preserve explicit skill invocation when a skill is hidden from model auto-discovery. If `.pi/settings.json` becomes empty after removing `skillful`, delete it.
