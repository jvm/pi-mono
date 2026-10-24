# pi-web-kit

Give [Pi](https://pi.dev) current web knowledge, authoritative library docs, and real-world code examples without flooding model context.

`pi-web-kit` combines search, page reading, version-aware documentation, and code research behind five agent-ready tools with bounded, cache-aware output.

## Features

- **Research the live web** — search current information and read single or multiple pages without leaving Pi.
- **Use docs that match the task** — resolve libraries and retrieve focused, version-aware documentation with code examples.
- **Find proven implementation patterns** — search practical usage, setup, migrations, and error context across real code.
- **Spend context wisely** — compact search results, chunked page reads, bounded output, and fetch caching keep research useful without overwhelming the model.
- **Compose research in scripts** — typed results let codemode filter and join data without parsing model-facing text.
- **Choose your providers** — mix Exa, TinyFish, Brave, Firecrawl, markdown.new, and Context7 based on coverage, cost, and credentials.

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
| Exa API | Use highlights-first `/search`, send task intent as `objective`, and batch `/contents` fetches when full pages are needed. Auto remains the default; Lite is opt-in. |
| TinyFish | Paginate only as needed; use dedicated filters; batch only enough top-result fetches to fill requested context; pass TTL and intent. |
| Brave | Return pre-extracted LLM Context in one search call with native URL, token, snippet, threshold, and Goggles controls. |
| Firecrawl | Return search metadata by default; use scrape-on-search only when requested; pass cache/main-content options. |
| markdown.new | Keep `method: auto` so native Markdown falls back to AI and browser rendering only as needed; keep images opt-in. |
| Context7 | Support `fast` mode to skip reranking and reduce latency. |
| Code examples | Use Exa `/search` with fixed Auto, live content, and bounded structured excerpts. Never Lite, synthesis, or Agent. |

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

### Terminal result views

`library_search`, `library_docs`, and `code_search` show compact completion
summaries instead of raw JSON in the interactive transcript. Expand a tool result
with Pi's expand-tools action (default: Ctrl+O) to inspect ranked library candidates,
available versions, documentation sources, or code source titles and URLs.
Long fields are clipped to the terminal width; version previews show at most two
entries plus the remaining count. Code-search summaries flag reduced output;
expanded views show omitted-source and context counts when present.

These views change presentation only. Model-facing JSON and typed codemode
results retain the same bounded, redacted data, including snippets and code.
Final print, JSON, and RPC tool results are unchanged.

### `web_search`

Searches with the active search provider and returns compact results grouped by query.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Single search query. |
| `queries` | string[] | Multiple related search queries. Max 5 after de-duplication. |
| `numResults` | integer | Desired results per query. Default: 10. Values above the active provider's limit are capped rather than rejected. |
| `contextTokens` | integer | Desired context across the result set. Default: 8,192; capped at 10,000. For Exa this only bounds returned highlights, not a request for page text. Other providers can enable extraction when explicit. |
| `purpose` | string | Required for Exa, optional for other search providers; up to 2,000 characters. Exa receives it as top-level `objective` to guide ranking and evidence selection. This does not select Deep Search or Agent. |

`numResults` controls source breadth. `contextTokens` controls grounding depth. The tool automatically keeps native/included Exa highlights and Brave LLM Context. Explicit `contextTokens` enables extra extraction for TinyFish and Firecrawl; this can add provider calls or provider cost. Exa always requests highlights and prefers them over text or summaries. Use `web_fetch` for complete pages, exact passages, or missing context. Search results keep a compact `snippet` plus ranked `content` and `contentFormat`, with one shared context budget and the existing 50KB tool-output limit.

Provider caps are Exa 100, Brave 50, and Firecrawl 100. TinyFish is paginated internally through its service maximum of page 10 and may make up to 11 search requests for one query. Search output reports requested, effective, returned, and omitted result/context counts. Brave `maxUrls` remains as a deprecated alias for `numResults`.

Other provider-specific parameters are exposed only for the configured provider. These include Exa date/domain filters; TinyFish domain, date, geography, language, and publication filters; Brave locale, freshness, spellcheck, Goggles, and LLM Context controls; and Firecrawl scrape/search options.

#### Exa modes, filters, and notices

- `type: "auto"` is the default. `type: "lite"` is an explicit lower-cost option
  that serves content from Exa's regularly refreshed index without query-time
  page fetching. When content is requested, Lite can exclude sources with no
  cached content. Use Auto when coverage or live freshness matters.
  Lite remains available for general `web_search`, but is never available in
  `code_search`.
- Lite accepts the exposed domain/path, publication-date, category, result-count,
  and purpose controls. Every `maxAgeHours` value, including `-1`, is rejected
  locally with guidance to use Auto. Unsupported overrides are not silently
  removed. Legacy search types remain accepted.
- `startCrawlDate` and `endCrawlDate` are deprecated and rejected: Exa ignores
  them. Publication dates describe a different constraint and are not substituted.
  The `company` and `people` categories reject publication-date filters; `people`
  also rejects `excludeDomains`.
- Exa query strings, including each `queries` entry, are limited to 2,000
  characters. `type` and `category` are limited to 64 characters. Each domain
  filter accepts at most 1,200 entries of up to 2,048 characters each.
  Publication-date strings are limited to 128 characters and must be ISO 8601
  dates. Blank query, purpose, mode, category, and domain/path strings are
  rejected. These local limits are declared in the tool schema.
- Each query group can include `notices: [{ code, message, path? }]` that explain
  changes to retrieval, such as relaxed query restrictions. At most 8 notices
  with 512-character messages are returned; `omittedNoticeCount` reports omitted
  entries. Notice codes are an open set. Arbitrary notice `details` are excluded.
- Ordinary `highlights: true` is the stable baseline. Dynamic Highlights is not
  enabled automatically: the announcement and current API guide disagree about
  its GA/beta status. The manual evaluation below tests the documented beta
  request separately; no beta header is sent by the production provider.

Exa `/search` calls emit best-effort
`pi-web-kit:exa-diagnostics` events through `pi.events`, outside model output.
Consumers can subscribe to capture request IDs, duration in milliseconds,
provider `searchTime` and `costDollars.total` when present, known search modes,
warning codes/field paths, and controlled failure categories/HTTP status.
Warning messages, queries, content, headers, and credentials are not included.
At most 8 warning identifiers are emitted, with `omittedWarningCount` for the
rest. No diagnostic file or remote log is created by this package.

#### Purpose, Search, Deep Search, and Agent

`purpose` is task intent, not a research-mode switch. Exa's Search best-practices
guide recommends a required objective in model-facing tools, including ordinary
Auto searches. Keep it short: name the implementation goal, exact dependency
version, and useful sources. The tool sends it as `objective` in the same request.
It does not send `outputSchema`, start Agent, or make a second API call.

| Product/path | Work performed | Cost/latency distinction |
|---|---|---|
| Search Auto, `/search` | Ranked sources and excerpts; Pi performs downstream reasoning | Standard Search price; live crawling adds latency |
| Deep Search, `/search` with a Deep type | Iterative research; optional synthesis via `outputSchema` | Higher published price and latency than Auto; explicitly selected in `web_search` only |
| Exa Agent, `/agent/runs` | Asynchronous, multi-step research, enrichment, verification, and optional data partners | Fixed-effort or metered run pricing; not used by this package |

Exa lists no separate `objective` charge. That is not a claim of zero processing
overhead or identical latency. Auto is currently $7 per 1,000 requests up to 10
results; Deep types have separate prices. See [pricing](https://exa.ai/docs/admin/pricing.md).
JSON returned by this extension is a local structured tool contract, not Exa's
paid synthesis feature.

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

For Exa, explicit `maxAgeHours` must be an integer from `-1` to `720`, in
both search and fetch calls. Larger `maxAgeMs` values remain valid: their
provider-side hour conversion is capped at 720, which requests content at least
as fresh as the caller requires. Sub-hour values round down, possibly to zero.
The original millisecond limit still governs the local cache. Explicit invalid
hour values are rejected even when `refresh: true` would otherwise override
them.

Exa Contents responses are matched by requested document IDs before canonical
URLs. Per-URL error statuses trigger fallback retrieval for only the failed or
missing pages; they cannot borrow another URL's result or cache it under the
failed URL. Failed pages are not cached. Identity-less legacy redirect results
use positional matching only for a complete batch or a single unambiguous pair.

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

Finds practical code examples, implementation context, setup snippets, migrations,
usage patterns, and error-message research through Exa Search Auto. The endpoint
is `/search`, not the undocumented legacy `/context`.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Required, up to 2,000 characters. Include language, exact dependency version, and operation or error. |
| `purpose` | string | Required nonblank task intent, up to 2,000 characters; sent as Search `objective`. |
| `numResults` | integer | Source breadth, 1–10. Default: 5. The ceiling avoids result-count surcharges. |
| `contextTokens` | integer | Local excerpt budget, 1–8,192. Default: 8,192. This is an approximate character-based budget, not an upstream token or synthesis request. |
| `includeDomains`, `excludeDomains` | string[] | Optional hard domain/path constraints; at most 1,200 entries of up to 2,048 characters each. Prefer soft source preferences in `purpose`. |

Code search always sends:

```json
{
  "type": "auto",
  "contents": {
    "highlights": true,
    "maxAgeHours": 0,
    "livecrawlTimeout": 15000
  }
}
```

There is no Lite, legacy fast/instant, Deep, cached-only, historical snapshot,
beta, or Agent override. No summary, `outputSchema`, or synthesized answer is
requested. It uses the Exa key regardless of the providers selected for general
web search and fetch. Search responses are not locally cached.

`maxAgeHours: 0` requests freshly fetched page content under Exa's documented
contract. It does **not** guarantee that every newly published page is indexed,
that a source matches the project's version, or that the provider's freshness
can be independently attested: Search does not return a per-page verified crawl
timestamp. `publishedDate` is an estimated publication date, not proof of a fresh
crawl. No publication-date filter is imposed on code search, because current
evergreen references can have old publication dates.

Only highlight evidence is returned. Metadata-only results and responses with
only text/summary fallbacks are omitted and counted in `omittedNoContentCount`;
the tool never substitutes cached-only retrieval when crawling fails. Errors
surface without automatic retry or endpoint/mode fallback. The HTTP deadline is
45 seconds, including JSON body consumption; the provider's individual live
crawl timeout is 15 seconds.

Results preserve complete source URLs, titles, excerpts, and publication dates
when present, with exact result/context omission accounting within the
50,000-byte JSON limit. Character counts use JavaScript UTF-16 string length;
prefixes do not split surrogate pairs. If evidence is incomplete, narrow the
query or use `web_fetch` with `refresh: true` on a cited URL. Excerpts are not
guaranteed to contain complete compilable functions.

**Breaking migration:** provide `purpose` for both Exa search tools, replace
`tokensNum`/`"dynamic"` with `contextTokens`, and read `results[].content` instead
of the old combined `response`. Legacy response/token metadata and aliases are
removed rather than silently translated.

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
| Code-search local context budget | 8,192 approximate tokens |
| Code-search result limit | 10 (default 5) |
| Serialized tool output | 50,000 bytes |
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
| `web_search` | `{ provider, queries: [{ query, requestedResultLimit, effectiveResultLimit, requestedContextTokens?, effectiveContextTokens, contextCharacters, omittedContextCharacters?, resultCount, omittedResultCount?, notices?, omittedNoticeCount?, results }] }`. Each result has `url` and optional `title`, `snippet`, `content`, `contentFormat`, `siteName`, `publishedDate`, `position`. |
| `web_fetch` | `{ provider, results }`. Each item is either `{ url, error }` or `{ url, fetchedUrl, title?, content, format, cached, refreshed, range }`. `range` has `offset`, `limit`, `returned`, `total`, `truncated`, `hasPrevious`, `hasNext`, and optional `nextOffset`. |
| `library_search` | `{ provider: "context7", libraryName, query, searchFilterApplied?, results }`. Each candidate has `id`; title, description, branch, dates, state, scores, counts, stars and versions are optional. |
| `library_docs` | `{ provider: "context7", libraryId, query, codeSnippets, infoSnippets }`. Code snippets expose optional title/description/language/ID/page/source/token fields and `codeList: [{ language, code }]`; info snippets require `content` with optional page/breadcrumb/token fields. |
| `code_search` | `{ provider: "exa", query, searchType: "auto", maxAgeHours: 0, requestedResultLimit, effectiveResultLimit, requestedContextTokens?, effectiveContextTokens, contextCharacters, omittedContextCharacters?, resultCount, omittedResultCount?, omittedNoContentCount?, notices?, omittedNoticeCount?, results }`. Sources have the same fields as web search. Freshness fields describe the request policy, not independent freshness verification. |

Every result also allows the top-level fallback `{ truncated: true, message }`
when metadata alone cannot fit. Check this before reading ordinary fields.
Both text and structured payloads stay within the same 50,000-byte JSON budget.
Fetch slices retain range continuation; search results report omitted counts.
Missing/invalid optional provider fields are omitted. Invalid required fields
fail the call rather than yielding a guessed success object.

```js
const search = await tools.web_search({ query: "Pi extension API", purpose: "Implement a tool with the installed Pi version; prefer official extension docs", numResults: 3 });
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
New optional tools activate when credentials first become available on reload,
including existing positive `defaultTools` selections. Previously registered
tools are not force-reactivated, even if settings still positively select them.
The extension records only previously registered tool names in branch-local
`pi-web-kit:registered-tools` session metadata, outside model context; it does
not store activation choices or credentials. The record is refreshed before
reload so navigating to older branch history cannot revive a manually disabled
tool. Older sessions without this metadata preserve inactivity on their first
reload, so they may require explicit activation or a restart.
Malformed/unknown-version metadata uses the same
conservative fallback.
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

### Manual terminal smoke test

From the monorepo root, with Context7 and Exa credentials configured:

```bash
pi -ne -e ./packages/pi-web-kit
```

Ask Pi to run `library_search` for a library with multiple matches, then
`library_docs` and `code_search` for a specific API question. Check that:

- Each running tool shows a short pending message without a percentage.
- Each completed result shows two summary rows rather than raw JSON.
- The expand-tools action (default: Ctrl+O) reveals candidate IDs and short
  version previews, the resolved docs library and sources, or ranked code URLs.
- Narrowing the terminal clips fields rather than adding wrapped output rows.
- Empty results and provider failures do not show a success heading.

Repeat in regular and fullscreen terminal modes when changing renderer layout.
Automated tests cover mocked provider calls through the registered renderers,
data-contract preservation, errors, output limits, Unicode, and narrow widths;
this manual check covers the host's interactive expansion and redraw behavior.

### Manual Exa comparison and smoke test

From the monorepo root, with `EXA_API_KEY` in the environment:

```bash
node --import tsx packages/pi-web-kit/tests/exa-evaluation.mjs --live
```

This opt-in, paid run sends 12 requests: three fixed public coding queries
(Node.js streams, Pydantic v2 migration, React 19 actions) through production
fresh-only code search, general Auto highlights, general Lite highlights, and
Auto Dynamic Highlights with the documented
`Exa-Beta: dynamic-highlights-2026-08-28` header. It makes no retries or follow-up
fetches. Lite and Dynamic are comparison paths for general web search, never
code-search configuration options. All paths request 5 results with an
8,000-character local search-context budget, followed by the same public output
projection and byte limiter used by the tools.

The JSON output includes latency, reported cost when available, raw/returned
character counts, serialized bytes, and source excerpts for human inspection.
`approximateTokens` is characters divided by four, not a tokenizer measurement.
Review version/operation match, usable code, citations, and whether a follow-up
fetch is needed. This is a small retrieval smoke test, not a downstream
answer-quality benchmark or proof that a returned page matches a dependency
version. The earlier legacy-Context comparison did not test this fresh-only
policy and is not a release gate for migration away from that API.

The deterministic tests exercise all 16 general search/fetch provider
combinations, every documented general search mode with freshness controls,
strict code-search override rejection, source/budget boundaries, stale-text
poisoning, credential masking, notices, HTTP failures, cancellation, and a stalled
response body after headers. Root contract tests exercise real Pi direct and
codemode dispatch, including rejection before provider access.

Contract references: [Search](https://exa.ai/docs/reference/search),
[Highlights](https://exa.ai/docs/search/highlights.md), and
[Code & Docs](https://exa.ai/docs/search/data/code.md). The live OpenAPI is
linked from those pages; check it again before changing beta defaults.

This package is source-distributed. Pi loads the TypeScript extension files directly via its extension loader.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and pull request guidelines.

## License

MIT. See [LICENSE](LICENSE).
