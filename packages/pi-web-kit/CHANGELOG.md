# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

## [0.2.0] - 2026-06-13

### Added

- Add `library_search` and `library_docs` tools backed by Context7.
- Add `code_search` backed by Exa Code.
- Gate optional developer-search tool registration on API key availability.

## [0.1.6] - 2026-06-06

### Changed

- Extract install telemetry to separate `src/install-telemetry.ts` module for consistency with monorepo guidelines.
- Add root `index.ts` re-export and fix `pi.extensions` path to `./index.ts`.
- Update `peerDependencies` to use `*` for Pi core packages.
- Add Pi core packages to `devDependencies` for type checking.
- Update `author` field to full name.

## [0.1.5] - 2026-05-20

### Changed

- Moved package source to the `jvm/pi-mono` monorepo.
- Updated npm metadata to point at the monorepo package directory.

## [0.1.4] - 2026-05-10

### Fixed

- Suppress install/update telemetry in CI environments, including GitHub Actions.

## [0.1.3] - 2026-05-10

### Added

- Install/update telemetry ping to `mocito.dev`, gated by Pi telemetry/offline settings and deduplicated per package version.

## [0.1.2] - 2026-05-09

### Changed

- Deduplicated `mapFetchResults` between extension and fallback provider; extension now imports the shared implementation.
- Replaced `existsSync` + `readFileSync` with a single `readFileSync` in a try/catch to eliminate TOCTOU race in config loading.
- Replaced nested ternary for `requireKey` env-var names with a lookup object.
- Replaced magic number `10` with `DEFAULT_NUM_RESULTS` in Exa, Exa MCP, and Firecrawl providers; replaced `10` with `MAX_URL_COUNT` in TinyFish.
- Fixed `urlsMatch` to compute `canonicalWebUrl` once per URL instead of twice.
- Moved `nextId` JSON-RPC counter from module scope to `ExaMcpProvider` instance to avoid ID conflicts across concurrent instances.
- Removed unused `_query` parameter from internal `normalizeSearch` in Exa MCP provider.
- Replaced O(n) completed-count recomputation in progress tracking with O(1) increment.
- Cached `buildCacheKey` results in `fetchWithCache` to avoid redundant URL parsing per fetched page.
- Replaced nested ternary chains in `providerScope` and `renderProgress` with lookup objects.

## [0.1.1] - 2026-05-09

### Fixed

- Show the Pi extension as `pi-web-kit` instead of `pi-web-kit:pi-web-kit` in the startup extensions list.

## [0.1.0] - 2026-05-09

### Added

- Initial `pi-web-kit` package with `web_search` and `web_fetch` Pi tools.
- Search providers: `exa_mcp`, `exa`, `tinyfish`, `brave`, and `firecrawl`.
- Fetch providers: `exa_mcp`, `exa`, `tinyfish`, `markdown_new`, and `firecrawl`.
- Provider-specific tool schemas, startup-provider mismatch guidance, and CLI provider override flags.
- In-memory fetch cache with TTL, LRU eviction, max entry count, max byte count, and fetch-affecting cache keys.
- URL validation and normalization for HTTP(S)-only URLs, credential rejection, fragment stripping, duplicate removal, and URL count/length caps.
- Request limits, bounded provider concurrency, fetch timeouts, and robust provider result mapping for canonicalized or redirected URLs.
- Tests for config precedence, provider behavior, cache safety, URL validation, concurrency, timeouts, and tool behavior.
- GitHub-ready project docs, issue templates, CI, and npm provenance publishing workflow.
