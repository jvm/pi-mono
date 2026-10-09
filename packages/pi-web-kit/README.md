# pi-web-kit

Give [Pi](https://pi.dev) current web knowledge, authoritative library docs, and real-world code examples without flooding model context.

`pi-web-kit` combines search, page reading, version-aware documentation, and code research behind five agent-ready tools with bounded, cache-aware output.

## Features

- **Research the live web** — search current information and read single or multiple pages without leaving Pi.
- **Use docs that match the task** — resolve libraries and retrieve focused, version-aware documentation with code examples.
- **Find proven implementation patterns** — search practical usage, setup, migrations, and error context across real code.
- **Spend context wisely** — compact search results, chunked page reads, bounded output, and fetch caching keep research useful without overwhelming the model.
- **Compose research in scripts** — typed results let codemode filter and join data without parsing model-facing text.
- **Choose your providers** — mix Exa, TinyFish, Brave, Firecrawl, markdown.new, Context7, and Exa Code based on coverage, cost, and credentials.

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
Use Pi 1.1.0 or newer and Node.js >=22.19.0 for the structured tool contracts.

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

Defaults: `provider_search = "exa"`, `provider_fetch = "exa"`.

| Provider | Search | Fetch | Key |
|---|---:|---:|---|
| `exa` | yes | yes | `EXA_API_KEY` |
| `tinyfish` | yes | yes | `TINYFISH_API_KEY` |
| `brave` | yes | no | `BRAVE_SEARCH_API_KEY` |
| `firecrawl` | yes | yes | `FIRECRAWL_API_KEY` |
| `markdown_new` | no | yes | none |

Tool schemas are tailored to the configured providers at startup/reload, so only supported provider-specific fields are exposed. Restart/reload Pi after changing provider config.

Provider-native efficiencies are used as follows:

| Service | Efficient path |
|---|---|
| Exa API | Keep included highlights; request bounded text in the same search only when requested; batch `/contents` fetches with freshness controls. |
| TinyFish | Paginate only as needed; use dedicated filters; batch only enough top-result fetches to fill requested context; pass TTL and intent. |
| Brave | Return pre-extracted LLM Context in one search call with native URL, token, snippet, threshold, and Goggles controls. |
| Firecrawl | Return search metadata by default; use scrape-on-search only when requested; pass cache/main-content options. |
| markdown.new | Keep `method: auto` so native Markdown falls back to AI and browser rendering only as needed; keep images opt-in. |
| Context7 | Support `fast` mode to skip reranking and reduce latency. |
| Exa Code | Send the requested/dynamic context token target directly to Exa Code Context. |

## Configuration

Resolution order: defaults < environment variables < global config < trusted project config < CLI flags. Project config is ignored unless Pi trusts the current project, including in print, JSON, and RPC modes.

### Environment variables

```bash
PI_OFFLINE=1        # disables install/update telemetry
PI_TELEMETRY=0      # disables install/update telemetry
PI_WEB_KIT_PROVIDER_SEARCH=exa|tinyfish|brave|firecrawl
PI_WEB_KIT_PROVIDER_FETCH=exa|tinyfish|markdown_new|firecrawl
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
| `numResults` | integer | Desired results per query. Default: 10. Values above the active provider's limit are capped rather than rejected. |
| `contextTokens` | integer | Desired extracted context across the result set. Omitted native context uses an 8,192-token output budget; an explicit value can enable extraction. Any positive value; capped at 10,000. |
| `purpose` | string | Optional task/use-case hint for providers that support separate intent. |

`numResults` controls source breadth. `contextTokens` controls grounding depth. The tool automatically keeps native/included Exa highlights and Brave LLM Context. Explicit `contextTokens` enables extra extraction for Exa, TinyFish, and Firecrawl; this can add provider calls or provider cost. Search results keep a compact `snippet` plus ranked `content` and `contentFormat`, with one shared context budget and the existing 50KB tool-output limit.

Provider caps are Exa 100, Brave 50, and Firecrawl 100. TinyFish is paginated internally through its service maximum of page 10 and may make up to 11 search requests for one query. Search output reports requested, effective, returned, and omitted result/context counts. Brave `maxUrls` remains as a deprecated alias for `numResults`.

Other provider-specific parameters are exposed only for the configured provider. These include Exa date/domain filters; TinyFish domain, date, geography, language, and publication filters; Brave locale, freshness, spellcheck, Goggles, and LLM Context controls; and Firecrawl scrape/search options.

### `web_fetch`

Fetches page content with the active fetch provider. Results are cached in memory by canonical URL plus provider/config/fetch-affecting options.

| Parameter | Type | Description |
|---|---|---|
| `url` | string | Single URL. Must be `http:` or `https:`. |
| `urls` | string[] | Multiple URLs. Max 10 after de-duplication. |
| `offset` | integer | Character offset for cached/ranged reads. Single URL only. |
| `limit` | integer | Maximum characters to return. Default: 30,000 for one URL, 8,000 for multiple URLs. |
| `refresh` | boolean | Refetch even if cached. |
| `maxAgeMs` | integer | Desired maximum local/provider-cached page age in milliseconds. `0` requests live content where supported. |

Provider-specific parameters are exposed only for the configured provider. TinyFish supports `purpose`, `format`, links/images, selectors, per-URL timeout, and a seconds-based `ttl` alias. Exa supports the hours-based `maxAgeHours` alias. markdown.new supports `method` / `retainImages`. Firecrawl supports `format`, `waitFor`, `mobile`, structured `location`, and its existing `maxAge` alias. `refresh: true` also requests live content from Exa, TinyFish, and Firecrawl instead of only bypassing the local cache.

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
| Provider `numResults` caps | Exa 100; Brave 50; Firecrawl 100 |
| Search context budget | 10,000 tokens |
| Max URL length | 2048 characters |

Cache keys include the provider, canonical URL, fetch-affecting parameters, relevant provider defaults, and an opaque SHA-256 API-key/account scope. Internal cache keys are never returned in tool output. `refresh: true` bypasses and replaces the cached entry.

## Structured results and discovery

All five tools declare `outputSchema` and return objects through `structuredContent`.
Codemode receives those objects directly; remove old `JSON.parse(await tools.…())`
wrappers. Direct calls still return useful JSON text with exactly the same
bounded, redacted value. Renderer `details` remain compact and are not the
script API.

| Tool | Script result |
| --- | --- |
| `web_search` | `{ provider, queries: [{ query, requestedResultLimit, effectiveResultLimit, requestedContextTokens?, effectiveContextTokens, contextCharacters, omittedContextCharacters?, resultCount, omittedResultCount?, results }] }`. Each result has `url` and optional `title`, `snippet`, `content`, `contentFormat`, `siteName`, `position`. |
| `web_fetch` | `{ provider, results }`. Each item is either `{ url, error }` or `{ url, fetchedUrl, title?, content, format, cached, refreshed, range }`. `range` has `offset`, `limit`, `returned`, `total`, `truncated`, `hasPrevious`, `hasNext`, and optional `nextOffset`. |
| `library_search` | `{ provider: "context7", libraryName, query, searchFilterApplied?, results }`. Each candidate has `id`; title, description, branch, dates, state, scores, counts, stars and versions are optional. |
| `library_docs` | `{ provider: "context7", libraryId, query, codeSnippets, infoSnippets }`. Code snippets expose optional title/description/language/ID/page/source/token fields and `codeList: [{ language, code }]`; info snippets require `content` with optional page/breadcrumb/token fields. |
| `code_search` | `{ provider: "exa", query, response, resultsCount?, searchTime?, outputTokens?, requestId? }`. Provider token counts are informational, not a second Pi usage report. |

Every result also allows the top-level fallback `{ truncated: true, message }`
when metadata alone cannot fit. Check this before reading ordinary fields.
Both text and structured payloads stay within the same 50,000-byte JSON budget.
Fetch slices retain range continuation; search results report omitted counts.
Missing/invalid optional provider fields are omitted. Invalid required fields
fail the call rather than yielding a guessed success object.

```js
const search = await tools.web_search({ query: "Pi extension API", numResults: 3 });
if ("truncated" in search) throw new Error(search.message);
const urls = search.queries.flatMap(q => q.results.map(r => r.url));
if (urls.length) {
  const pages = await tools.web_fetch({ urls: urls.slice(0, 10) });
  if ("truncated" in pages) throw new Error(pages.message);
  text(pages.results.filter(r => !("error" in r)).map(r => ({
    url: r.url, excerpt: r.content.slice(0, 500), nextOffset: r.range.nextOffset
  })));
}
```

Validation, whole-request/provider, malformed-output and cancellation failures
throw: direct calls become Pi tool errors and scripts must use `try`/`catch` or
`Promise.allSettled`. Individual fetch failures are successful result data with
an `error` field, not `isError: true`. These tools do not return structured success
objects alongside `isError: true`. A trusted result hook can replace that contract;
annotations do not bypass hooks or approvals.

The namespace is `web`, not a name prefix: calls remain `tools.web_fetch(…)`.
`await describeNamespace("web")`, `await describeTool("web_fetch")`, and
`await searchTools("page content", { namespace: "web" })` work even with
`codemode.inlineBudget: 0`. Independent reads can run in parallel. The advisory
hints are read-only, non-destructive, idempotent, and open-world: repeated reads
can return different content and incur provider charges.

Direct exposure remains the default, and codemode is optional. No package-level
deferred/codemode exposure switch is added: it would make inactive direct tools
nested-callable and change the meaning of disabling them. Use Pi's `codemode.mode`
(`on` or `only`) and `inlineBudget` to reduce declarations while retaining the
active-tool boundary. Optional research tools still require their provider keys.
Explicit `defaultTools` `-name` entries are honored at late registration; reload
restores Pi's active selection rather than re-enabling manually disabled tools.
Newly available tools after a reload may need explicit activation (for example,
add `+library_docs` to `defaultTools`) or a restart.
CLI exclusions remain host-enforced.

## Privacy and security

`pi-web-kit` sends search queries and fetched URLs to the configured provider. Developer-search tools send library/doc queries to Context7 and code-context queries to Exa when those tools are enabled. Fetch providers may also receive provider-specific options. API keys are read from environment variables or local config files and are used only for provider requests.

The extension rejects non-HTTP(S) URLs and URLs with embedded username/password credentials.
Returned data is projected to declared public fields; raw provider metadata,
Context7 `rules`, cache keys and HTTP error bodies are not returned. Known API
keys, URL credential patterns and Basic/Bearer authorization-header values are masked in text, structured data,
renderer details and progress. This is not a general sensitive-data scanner:
page content remains untrusted, and Pi retains caller-supplied arguments in its
own transcript. Do not put credentials in queries or URLs.

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

- Node.js >= 22.19.0
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
