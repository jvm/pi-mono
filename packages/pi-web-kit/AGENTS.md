# Repository Guidelines

## Project Structure & Module Organization

`pi-web-kit` is a source-distributed TypeScript Pi package. Pi loads TypeScript files directly, so runtime code lives under `src/` rather than `dist/`.

- `src/index.ts` exports the public package surface.
- `src/config.ts`, `src/http.ts`, `src/cache.ts`, `src/limits.ts`, `src/urls.ts`, and `src/types.ts` hold shared code.
- `src/providers/` contains Exa, TinyFish, Brave, Firecrawl, markdown.new, and fallback integrations.
- `extensions/index.ts` registers Pi tools and should stay focused on extension wiring.
- `tests/*.test.mjs` contains Node test-runner coverage.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md` cover behavior and releases.

## Build, Test, and Development Commands

Use the monorepo root `package-lock.json`; do not create a package-local lockfile. Run dependency updates from the monorepo root with a workspace scope:

```bash
npm install -w packages/pi-web-kit
npm run -w packages/pi-web-kit check
npm test -w packages/pi-web-kit
npm run -w packages/pi-web-kit pack:dry-run
```

- `npm run check` / `npm run typecheck`: run `tsc --noEmit`.
- `npm test`: run Node tests with `tsx` over `tests/*.test.mjs`.
- `npm run pack:dry-run`: inspect published package contents before release.

For local Pi testing:

```bash
pi -e /path/to/pi-mono/packages/pi-web-kit --web-provider-fetch markdown_new --print "Fetch https://example.com"
```

## Coding Style & Naming Conventions

Use ESM TypeScript with 2-space indentation and explicit `.ts` import extensions. Keep public provider names, config keys, environment variables, and cache semantics stable; changing them can be breaking. Move reusable logic into `src/`; keep Pi registration in `extensions/index.ts`.

When changing tool parameters, update the Typebox schema, runtime validation, README docs, and tests together. Validate and normalize external URLs before provider calls, and use shared limits, timeouts, cache, and truncation helpers.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict` in `.test.mjs` files. Name tests by observable behavior, for example `test("keyed providers fail clearly when keys are missing", ...)`. Mock `globalThis.fetch` inside tests and restore it in `finally` blocks. Run `npm test` and `npm run check` before opening a pull request.

## Commit & Pull Request Guidelines

Recent history uses concise imperative or release-style subjects such as `Add npm publish workflow` and `Release 0.1.2`. Keep commits focused and avoid unrelated file churn.

Pull requests should include a short description, linked issue when applicable, and notes about provider, config, or schema changes. Before submitting, run `npm run check`, `npm test`, `npm audit --omit=dev`, and `npm run pack:dry-run`. Update `README.md` for user-facing changes and `CHANGELOG.md` for notable changes.

## Security & Configuration Tips

Never commit API keys, tokens, machine-specific paths, or provider config containing secrets. Local project config belongs in `.pi-web-kit.json`, which this repository ignores. Treat `EXA_API_KEY`, `TINYFISH_API_KEY`, `BRAVE_SEARCH_API_KEY`, and `FIRECRAWL_API_KEY` as sensitive.
