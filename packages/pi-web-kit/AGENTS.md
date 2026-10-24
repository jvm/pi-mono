# pi-web-kit Guidelines

Root `AGENTS.md` applies.

## Invariants

- Keep tool schemas, runtime validation, config, docs, and tests synchronized.
- Validate URLs before provider calls; preserve shared limits, timeouts, truncation, and cache scope.
- Never expose API keys or secret-bearing cache keys.
- Project config requires trust. Provider schema changes apply at startup/reload.
- Mock network calls deterministically and restore globals after tests.

## Validation

```bash
npm run -w packages/pi-web-kit check
npm test -w packages/pi-web-kit
npm run -w packages/pi-web-kit pack:dry-run
```

Smoke test affected provider with smallest non-secret configuration.

## Development

Run a single test file:

```bash
node --import tsx --test tests/config.test.mjs
```

Local Pi testing (no install required):

```bash
pi -e /path/to/pi-mono/packages/pi-web-kit --web-provider-fetch markdown_new --print "Fetch https://example.com"
```

## Architecture

Data flow: Pi tool call → `extensions/index.ts` (tool registration) → `src/config.ts` (config resolution) → `src/providers/index.ts` (provider factory) → external API → cache/truncation → Pi TUI output.

| Module | Role |
|---|---|
| `extensions/index.ts` | Registers the five research tools plus `--web-provider-search`/`--web-provider-fetch` CLI flags. Keep focused on wiring only. |
| `src/config.ts` | Multi-layer config resolution (see precedence below). |
| `src/providers/` | Backend implementations, Context7, and fetch fallbacks. `exa-contract.ts` isolates Exa request validation, notices, and diagnostic projection; `exa-contents.ts` maps per-document statuses and result identities. |
| `src/code-output.ts` | Strict code-search options, local context budgets, and byte-aware structured-source limits with omission accounting. |
| `src/limits.ts` | Single source of truth for all hard limits (timeouts, cache size, concurrency, URL count, etc.). |
| `src/cache.ts` | In-memory fetch cache: TTL, LRU eviction, byte budget. |
| `src/urls.ts` | URL validation, normalization, credential rejection, fragment stripping. All URLs pass through here before provider calls. |

Config precedence (lowest → highest):

1. Hardcoded defaults (`provider_search: "exa"`, `provider_fetch: "exa"`)
2. Env vars: `PI_WEB_KIT_PROVIDER_SEARCH`, `PI_WEB_KIT_PROVIDER_FETCH`, `EXA_API_KEY`, `TINYFISH_API_KEY`, `BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, `CONTEXT7_API_KEY`
3. Global config: `~/.pi/agent/pi-web-kit.json`
4. Project config: `.pi-web-kit.json` (gitignored, never commit)
5. CLI flags: `--web-provider-search`, `--web-provider-fetch`

## Conventions

- When changing tool parameters, update the Typebox schema, runtime validation, README, and tests together.
- Provider names, config keys, and env var names are public API; treat changes as breaking.
