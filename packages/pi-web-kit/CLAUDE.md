# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps
npm run check        # type-check (tsc --noEmit)
npm test             # run all tests
npm run pack:dry-run # verify published package contents
```

Run a single test file:
```bash
node --import tsx --test tests/config.test.mjs
```

Local Pi testing (no install required):
```bash
pi -e /path/to/pi-mono/packages/pi-web-kit --web-provider-fetch markdown_new --print "Fetch https://example.com"
```

## Architecture

**pi-web-kit** is a source-distributed Pi agent extension (no build step). Pi loads TypeScript directly; there is no `dist/`.

### Data flow

Pi tool call → `extensions/index.ts` (tool registration) → `src/config.ts` (config resolution) → `src/providers/index.ts` (provider factory) → external API → cache/truncation → Pi TUI output.

### Key modules

| Module | Role |
|---|---|
| `extensions/index.ts` | Pi extension entry point; registers `web_search` and `web_fetch` tools plus CLI flags. Keep focused on wiring only. |
| `src/index.ts` | Public package surface; re-exports types, config, and provider factories. |
| `src/config.ts` | Multi-layer config resolution: defaults → env vars → `~/.pi/agent/pi-web-kit.json` → `.pi-web-kit.json` → CLI flags. |
| `src/providers/` | One file per backend (Exa, TinyFish, Brave, Firecrawl, markdown.new, exa_mcp). Each implements `SearchProvider` or `FetchProvider`. |
| `src/limits.ts` | Single source of truth for all hard limits (timeouts, cache size, concurrency, URL count, etc.). |
| `src/cache.ts` | In-memory fetch cache: TTL, LRU eviction, byte budget. |
| `src/urls.ts` | URL validation, normalization, credential rejection, fragment stripping. All URLs pass through here before provider calls. |

### Config precedence (lowest → highest)
1. Hardcoded defaults (`provider_search: "exa_mcp"`)
2. Env vars: `PI_WEB_KIT_PROVIDER_SEARCH`, `PI_WEB_KIT_PROVIDER_FETCH`, `EXA_API_KEY`, `TINYFISH_API_KEY`, `BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`
3. Global config: `~/.pi/agent/pi-web-kit.json`
4. Project config: `.pi-web-kit.json` (gitignored, never commit)
5. CLI flags: `--web-provider-search`, `--web-provider-fetch`

## Coding conventions

- ESM TypeScript, 2-space indent, explicit `.ts` import extensions (e.g. `import { foo } from "./foo.js"` resolves to `foo.ts` at runtime via tsx).
- Tests use `node:test` and `node:assert/strict` in `.test.mjs` files. Mock `globalThis.fetch` and restore in `finally` blocks. Name tests by observable behavior.
- When changing tool parameters: update Typebox schema, runtime validation, README, and tests together.
- Provider names, config keys, and env var names are public API — treat changes as breaking.
- New reusable logic belongs in `src/`; Pi wiring belongs in `extensions/index.ts`.
