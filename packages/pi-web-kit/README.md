# pi-web-kit

Context-efficient web and developer search tools for [Pi](https://pi.dev): `web_search`, `web_fetch`, `library_search`, `library_docs`, and `code_search`.

`pi-web-kit` provides provider-backed search, page fetching, library docs lookup, and code-context search with bounded output, chunked reads, URL validation, and an in-memory fetch cache designed for agent workflows.

## Features

- `web_search` for current/external web information, including multi-query searches.
- `web_fetch` for reading one or more URLs, with `offset` / `limit` chunk reads for long pages.
- `library_search` and `library_docs` for library resolution and current, version-aware documentation/code examples.
- `code_search` for practical examples and implementation context.
- Multiple provider backends: Exa MCP, Exa API, TinyFish, Brave Search, Firecrawl, markdown.new, Context7, and Exa Code.
- Provider-tailored tool schemas at Pi startup/reload.
- URL validation: HTTP(S)-only, no embedded credentials, fragment stripping, duplicate removal, and length/count limits.
- In-memory fetch cache with TTL, LRU eviction, max entry count, max byte count, and cache keys based on provider/config/fetch-affecting options.
- Bounded provider concurrency and network timeouts.

## Installation

Install from npm:

```bash
pi install npm:pi-web-kit
```

Install project-locally with Pi's `-l` flag:

```bash
pi install -l npm:pi-web-kit
```

During local development from this monorepo:

```bash
pi install /path/to/pi-mono/packages/pi-web-kit
```

For a one-off test run without installing:

```bash
pi -e /path/to/pi-mono/packages/pi-web-kit --web-provider-fetch markdown_new --print "Fetch https://example.com"
```

This is an npm-compatible TypeScript Pi package. Bun is not required.

## Quick usage

Search:

```text
Find recent documentation for the Pi extension API.
```

Multi-query search:

```text
Search for recent docs on Pi extensions and Pi tool schemas.
```

Fetch a page:

```text
Read https://example.com and summarize it.
```

Fetch a long page in chunks:

```text
Fetch https://example.com/long-doc with limit 8000, then continue with offset 8000.
```

Pi chooses `web_search` or `web_fetch` automatically when the request calls for it. You can also mention provider settings explicitly in prompts, but provider changes usually require config or CLI flags.

## Providers

Defaults: `provider_search = "exa_mcp"`, `provider_fetch = "exa_mcp"`.

| Provider | Search | Fetch | Key |
|---|---:|---:|---|
| `exa_mcp` | yes | yes | optional `EXA_API_KEY` |
| `exa` | yes | yes | `EXA_API_KEY` |
| `tinyfish` | yes | yes | `TINYFISH_API_KEY` |
| `brave` | yes | no | `BRAVE_SEARCH_API_KEY` |
| `firecrawl` | yes | yes | `FIRECRAWL_API_KEY` |
| `markdown_new` | no | yes | none |

Tool schemas are tailored to the configured providers at startup/reload, so only supported provider-specific fields are exposed. Restart/reload Pi after changing provider config.

## Configuration

Resolution order: defaults < environment variables < global config < trusted project config < CLI flags. Project config is ignored unless Pi trusts the current project, including in print, JSON, and RPC modes.

### Environment variables

```bash
PI_OFFLINE=1        # disables install/update telemetry
PI_TELEMETRY=0      # disables install/update telemetry
PI_WEB_KIT_PROVIDER_SEARCH=exa_mcp|exa|tinyfish|brave|firecrawl
PI_WEB_KIT_PROVIDER_FETCH=exa_mcp|exa|tinyfish|markdown_new|firecrawl
EXA_API_KEY=...          # enables Exa provider and code_search
CONTEXT7_API_KEY=...     # enables library_search and library_docs
TINYFISH_API_KEY=...
BRAVE_SEARCH_API_KEY=...
FIRECRAWL_API_KEY=...
```

### Config files

Config files, in increasing precedence:

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/pi-web-kit.json` |
| Project | `.pi-web-kit.json` |

Example:

```json
{
  "provider_search": "firecrawl",
  "provider_fetch": "markdown_new",
  "apiKeys": {
    "firecrawl": "...",
    "context7": "...",
    "exa": "..."
  },
  "markdownNew": {
    "method": "auto",
    "retainImages": false
  }
}
```

Do not commit config files containing secrets. Project `.pi-web-kit.json` is ignored by this repo's `.gitignore`, but other repositories may need their own ignore rule.

### CLI overrides

```bash
pi -e . --web-provider-search firecrawl --web-provider-fetch markdown_new --print "Search and fetch docs"
```

Provider CLI flags are temporary for the Pi process. Restart/reload Pi after changing provider config so registered tool schemas match the active provider.

## Tools

### `web_search`

Searches with the active search provider and returns compact results grouped by query.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Single search query. |
| `queries` | string[] | Multiple related search queries. Max 5 after de-duplication. |
| `numResults` | integer | Results per query. Range: 1-20. Default: 10. |

Provider-specific parameters are exposed only for the configured provider, such as Exa date/domain filters, TinyFish `page`, Brave locale/freshness options, or Firecrawl scrape/search options.

### `web_fetch`

Fetches page content with the active fetch provider. Results are cached in memory by canonical URL plus provider/config/fetch-affecting options.

| Parameter | Type | Description |
|---|---|---|
| `url` | string | Single URL. Must be `http:` or `https:`. |
| `urls` | string[] | Multiple URLs. Max 10 after de-duplication. |
| `offset` | integer | Character offset for cached/ranged reads. Single URL only. |
| `limit` | integer | Maximum characters to return. Default: 30,000 for one URL, 8,000 for multiple URLs. |
| `refresh` | boolean | Refetch even if cached. |

Provider-specific parameters are exposed only for the configured provider, such as TinyFish `format`, markdown.new `method` / `retainImages`, or Firecrawl `format`, `waitFor`, `mobile`, `location`, and `maxAge`.

### `library_search`

Resolves packages, frameworks, SDKs, APIs, CLIs, and libraries to canonical library IDs.

| Parameter | Type | Description |
|---|---|---|
| `libraryName` | string | Library/package/framework name to search for. |
| `query` | string | Optional user task/question for relevance ranking. |
| `fast` | boolean | Skip LLM reranking for lower latency. |
| `limit` | integer | Maximum libraries to return. Range: 1-20. Default: 10. |

### `library_docs`

Fetches current docs and code snippets for a library. Provide `libraryId`, or provide `libraryName` and the tool resolves the best match first.

| Parameter | Type | Description |
|---|---|---|
| `libraryId` | string | Canonical library ID, such as `/vercel/next.js`. |
| `libraryName` | string | Library name to resolve when `libraryId` is not known. |
| `query` | string | Specific docs question or coding task. |
| `version` | string | Optional version/tag to pin, appended as `@version`. |
| `fast` | boolean | Skip LLM reranking for lower latency. |
| `limit` | integer | Maximum code and info snippets to return. Range: 1-20. Default: 10. |

### `code_search`

Finds practical code examples, implementation context, setup snippets, migrations, usage patterns, and error-message research.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Code-context query. |
| `tokensNum` | `"dynamic"` or integer | Output token target. Integer range: 50-100000. Default: `"dynamic"`. |

## Cache and limits

`web_fetch` uses an in-memory cache for the current Pi process.

| Limit | Value |
|---|---:|
| Cache TTL | 30 minutes |
| Max cached entries | 100 |
| Max cached bytes | 20 MiB |
| Max URLs per call | 10 |
| Max queries per call | 5 |
| Max `numResults` | 20 |
| Max URL length | 2048 characters |

Cache keys include the provider, canonical URL, fetch-affecting parameters, relevant provider defaults, and an opaque SHA-256 API-key/account scope. Internal cache keys are never returned in tool output. `refresh: true` bypasses and replaces the cached entry.

## Privacy and security

`pi-web-kit` sends search queries and fetched URLs to the configured provider. Developer-search tools send library/doc queries to Context7 and code-context queries to Exa when those tools are enabled. Fetch providers may also receive provider-specific options. API keys are read from environment variables or local config files and are used only for provider requests.

The extension rejects non-HTTP(S) URLs and URLs with embedded username/password credentials. Provider responses are not sandboxed; they are returned to Pi as tool output.

Report security issues privately. See [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `provider requires ... API_KEY` | Selected provider needs an API key. | Set the provider's env var or `apiKeys` config entry. |
| Provider mismatch / schema error after config change | Pi registered tools for the previous startup provider. | Restart/reload Pi after provider changes. |
| Invalid URL / scheme / credentials error | URL validation rejected the input. | Use an absolute `http:` or `https:` URL without username/password credentials. |
| Timeout error | Provider request exceeded its timeout. | Retry, reduce URL count, or switch provider. |
| No content returned | Provider returned no matching content or a redirected/canonicalized response could not be mapped. | Retry with `refresh: true`, fetch a single URL, or switch provider. |
| Large page is truncated | Tool output is bounded to valid JSON under 50KB. | Continue with the returned `range.nextOffset`. |

## Development

Requirements:

- Node.js >= 20.6.0
- npm

Common commands:

```bash
npm install
npm run check
npm test
npm audit --omit=dev
npm run pack:dry-run
```

This package is source-distributed. Pi loads the TypeScript extension files directly via its extension loader.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and pull request guidelines.

## License

MIT. See [LICENSE](LICENSE).
