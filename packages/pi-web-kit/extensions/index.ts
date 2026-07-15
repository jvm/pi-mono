import { createHash } from "node:crypto";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fetchCache, type CachedPage } from "../src/cache.js";
import { resolveConfig } from "../src/config.js";
import { DEFAULT_FETCH_LIMIT, DEFAULT_NUM_RESULTS, MAX_LIMIT, MAX_NUM_RESULTS, MAX_OFFSET, MAX_QUERY_COUNT, MAX_URL_COUNT, MULTI_FETCH_LIMIT } from "../src/limits.js";
import { createCodeSearchProvider, createContext7Provider, createFetchProvider, createSearchProvider } from "../src/providers/index.js";
import { mapFetchResults } from "../src/providers/fallback.js";
import type { FetchProviderName, SearchProviderName, WebFetchResult } from "../src/types.js";
import { canonicalWebUrl, normalizeUrlInput } from "../src/urls.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";

export default function (pi: ExtensionAPI) {
  void reportInstallTelemetry();
  pi.registerFlag("web-provider-search", {
    description: "Temporary pi-web-kit search provider override (exa_mcp, exa, tinyfish, brave, firecrawl)",
    type: "string",
  });
  pi.registerFlag("web-provider-fetch", {
    description: "Temporary pi-web-kit fetch provider override (exa_mcp, exa, tinyfish, markdown_new, firecrawl)",
    type: "string",
  });

  let registeredConfig = "";
  pi.on("session_start", (_event, ctx) => {
    const startupConfig = runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx));
    const signature = toolConfigSignature(startupConfig);
    if (signature === registeredConfig) return;
    registerTools(pi, startupConfig);
    syncOptionalTools(pi, startupConfig);
    registeredConfig = signature;
  });
}

function registerTools(pi: ExtensionAPI, startupConfig: ReturnType<typeof resolveConfig>) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: buildSearchDescription(startupConfig.provider_search),
    promptSnippet: "Find current or external web information.",
    promptGuidelines: ["Use web_search to find current or external web information."],
    parameters: buildSearchSchema(startupConfig.provider_search),
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as Record<string, any>;
      const queries = normalizeQueries(params);
      const numResults = parseInteger(params.numResults, DEFAULT_NUM_RESULTS, "numResults", 1, MAX_NUM_RESULTS);
      if (queries.length === 0) throw new Error("web_search requires query or queries.");

      const config = runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx));
      assertProviderUnchanged("web_search", startupConfig.provider_search, config.provider_search);
      const provider = createSearchProvider(config);
      const grouped = [];
      const progress = createProgress("search", config.provider_search, queries);
      emitProgress(onUpdate, progress);
      for (const query of queries) {
        markProgressCurrent(progress, query);
        emitProgress(onUpdate, progress);
        const result = await provider.search({ ...params, query, numResults }, signal);
        grouped.push({ query, results: result.results });
        markProgressDone(progress, query, `${result.results.length} results`);
        emitProgress(onUpdate, progress);
      }
      const result = { provider: config.provider_search, queries: grouped };
      return jsonToolResult(result);
    },
    renderCall(args, theme) {
      return new Text(renderWebCall("search", args as Record<string, any>, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderWebResult("search", result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: buildFetchDescription(startupConfig.provider_fetch),
    promptSnippet: "Read page content from URL(s), with offset/limit for long pages.",
    promptGuidelines: ["Use web_fetch when the user provides URLs or asks to read page content."],
    parameters: buildFetchSchema(startupConfig.provider_fetch),
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as Record<string, any>;
      const urls = normalizeUrls(params);
      if (urls.length === 0) throw new Error("web_fetch requires url or urls.");
      if (urls.length > 1 && params.offset != null && params.offset !== 0) {
        throw new Error("web_fetch offset range reads require a single url, not urls.");
      }

      const config = runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx));
      assertProviderUnchanged("web_fetch", startupConfig.provider_fetch, config.provider_fetch);
      const progress = createProgress("fetch", config.provider_fetch, urls);
      const result = await fetchWithCache(config.provider_fetch, params, urls, signal, config, (event) => {
        updateFetchProgress(progress, event);
        emitProgress(onUpdate, progress);
      });
      return jsonToolResult(result);
    },
    renderCall(args, theme) {
      return new Text(renderWebCall("fetch", args as Record<string, any>, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderWebResult("fetch", result, options, theme, context);
    },
  });

  if (startupConfig.apiKeys.context7) {
    pi.registerTool({
      name: "library_search",
      label: "Library Search",
      description: "Resolve library, package, framework, SDK, API, or CLI names to canonical library IDs.",
      promptSnippet: "Resolve a library name to a canonical library ID before querying docs.",
      promptGuidelines: ["Use library_search when a library/framework/package is ambiguous or you need a canonical library ID."],
      parameters: buildLibrarySearchSchema(),
      async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
        const params = rawParams as Record<string, any>;
        const libraryName = requiredString(params.libraryName, "libraryName");
        const query = optionalString(params.query, "query") ?? libraryName;
        const limit = parseInteger(params.limit, 10, "limit", 1, MAX_NUM_RESULTS);
        const provider = createContext7Provider(runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx)));
        const result = await provider.searchLibraries({ libraryName, query, fast: params.fast === true, limit }, signal);
        return jsonToolResult(result);
      },
    });

    pi.registerTool({
      name: "library_docs",
      label: "Library Docs",
      description: "Fetch current, version-aware documentation and code examples for a library.",
      promptSnippet: "Get current library documentation and code examples.",
      promptGuidelines: ["Use library_docs for current APIs, framework behavior, SDK examples, package docs, and version-specific library questions."],
      parameters: buildLibraryDocsSchema(),
      async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
        const params = rawParams as Record<string, any>;
        const query = requiredString(params.query, "query");
        const limit = parseInteger(params.limit, 10, "limit", 1, MAX_NUM_RESULTS);
        const provider = createContext7Provider(runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx)));
        let libraryId = optionalString(params.libraryId, "libraryId");
        if (!libraryId) {
          const libraryName = requiredString(params.libraryName, "libraryName");
          const resolved = await provider.searchLibraries({ libraryName, query, fast: params.fast === true, limit: 1 }, signal);
          libraryId = resolved.results[0]?.id;
          if (!libraryId) throw new Error(`No library found for '${libraryName}'. Try library_search with a more specific name.`);
        }
        const result = await provider.getDocs({ libraryId, query, version: optionalString(params.version, "version"), type: "json", fast: params.fast === true, limit }, signal);
        return jsonToolResult(result);
      },
    });
  }

  if (startupConfig.apiKeys.exa) {
    pi.registerTool({
      name: "code_search",
      label: "Code Search",
      description: "Find practical code examples, usage patterns, setup snippets, migrations, and error context.",
      promptSnippet: "Find real-world code examples, usage patterns, migrations, and error context.",
      promptGuidelines: ["Use code_search for real-world code examples, GitHub/open-source usage patterns, API syntax examples, setup snippets, migrations, and error messages."],
      parameters: buildCodeSearchSchema(),
      async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
        const params = rawParams as Record<string, any>;
        const query = requiredString(params.query, "query");
        const tokensNum = parseTokensNum(params.tokensNum);
        const provider = createCodeSearchProvider(runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx)));
        const result = await provider.searchCode({ query, tokensNum }, signal);
        return jsonToolResult(result);
      },
    });
  }
}

const OPTIONAL_TOOLS = ["library_search", "library_docs", "code_search"];

function toolConfigSignature(config: ReturnType<typeof resolveConfig>): string {
  return JSON.stringify({
    search: config.provider_search,
    fetch: config.provider_fetch,
    context7: !!config.apiKeys.context7,
    exa: !!config.apiKeys.exa,
  });
}

function syncOptionalTools(pi: ExtensionAPI, config: ReturnType<typeof resolveConfig>) {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const enabled = [
    ...(config.apiKeys.context7 ? ["library_search", "library_docs"] : []),
    ...(config.apiKeys.exa ? ["code_search"] : []),
  ];
  const active = pi.getActiveTools().filter((name) => !OPTIONAL_TOOLS.includes(name));
  pi.setActiveTools([...new Set([...active, ...enabled])]);
}

type ProgressKind = "search" | "fetch";
type ProgressItem = { label: string; status: "pending" | "current" | "done" | "error"; note?: string; error?: string };
type WebProgress = { kind: ProgressKind; provider: string; total: number; completed: number; items: ProgressItem[] };
type FetchProgressEvent = { status: "current" | "done" | "error"; url: string; note?: string; error?: string };

const int = (description: string, min: number, max?: number) => Type.Integer({ description, minimum: min, ...(max == null ? {} : { maximum: max }) });

export function buildSearchSchema(provider: SearchProviderName) {
  const props: Record<string, any> = {
    query: Type.Optional(Type.String({ description: "Single search query" })),
    queries: Type.Optional(Type.Array(Type.String(), { description: `Multiple related search queries (max ${MAX_QUERY_COUNT})`, maxItems: MAX_QUERY_COUNT })),
    numResults: Type.Optional(int("Results per query", 1, MAX_NUM_RESULTS)),
  };
  if (provider === "exa") Object.assign(props, {
    includeDomains: Type.Optional(Type.Array(Type.String())),
    excludeDomains: Type.Optional(Type.Array(Type.String())),
    startPublishedDate: Type.Optional(Type.String()),
    endPublishedDate: Type.Optional(Type.String()),
    startCrawlDate: Type.Optional(Type.String()),
    endCrawlDate: Type.Optional(Type.String()),
    type: Type.Optional(Type.String()),
    category: Type.Optional(Type.String()),
  });
  if (provider === "tinyfish") Object.assign(props, { page: Type.Optional(int("Result page", 1, 10)) });
  if (provider === "brave") Object.assign(props, {
    country: Type.Optional(Type.String()), searchLang: Type.Optional(Type.String()), uiLang: Type.Optional(Type.String()), safesearch: Type.Optional(Type.String()), freshness: Type.Optional(Type.String()), maxUrls: Type.Optional(int("Maximum URLs", 1, MAX_NUM_RESULTS)),
  });
  if (provider === "firecrawl") Object.assign(props, {
    location: Type.Optional(Type.String()), country: Type.Optional(Type.String()), includeDomains: Type.Optional(Type.Array(Type.String())), excludeDomains: Type.Optional(Type.Array(Type.String())), categories: Type.Optional(Type.Array(Type.String())), tbs: Type.Optional(Type.String()), scrape: Type.Optional(Type.Boolean({ description: "Enable default markdown scrape-on-search" })), scrapeOptions: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Firecrawl scrapeOptions for search." })),
  });
  return Type.Object(props, { additionalProperties: false });
}

export function buildFetchSchema(provider: FetchProviderName) {
  const props: Record<string, any> = {
    url: Type.Optional(Type.String({ description: "Single URL", maxLength: 2048 })),
    urls: Type.Optional(Type.Array(Type.String({ maxLength: 2048 }), { description: `Multiple URLs (max ${MAX_URL_COUNT})`, maxItems: MAX_URL_COUNT })),
    offset: Type.Optional(int("Character offset for cached/ranged reads", 0, MAX_OFFSET)),
    limit: Type.Optional(int("Maximum characters to return", 1, MAX_LIMIT)),
    refresh: Type.Optional(Type.Boolean({ description: "Refetch even if cached" })),
  };
  if (provider === "tinyfish") Object.assign(props, { format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("json")])), links: Type.Optional(Type.Boolean()), imageLinks: Type.Optional(Type.Boolean()) });
  if (provider === "markdown_new") Object.assign(props, { method: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("ai"), Type.Literal("browser")])), retainImages: Type.Optional(Type.Boolean()) });
  if (provider === "firecrawl") Object.assign(props, {
    format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("json")])),
    onlyMainContent: Type.Optional(Type.Boolean()), waitFor: Type.Optional(int("Milliseconds to wait", 0, 60_000)), mobile: Type.Optional(Type.Boolean()), location: Type.Optional(Type.String()), maxAge: Type.Optional(int("Maximum cached page age", 0)),
  });
  return Type.Object(props, { additionalProperties: false });
}

export function buildLibrarySearchSchema() {
  return Type.Object({
    libraryName: Type.String({ description: "Library, package, framework, SDK, API, CLI, or product name", minLength: 1, maxLength: 500 }),
    query: Type.Optional(Type.String({ description: "User task/question used for relevance ranking", minLength: 1, maxLength: 500 })),
    fast: Type.Optional(Type.Boolean({ description: "Skip LLM reranking for lower latency" })),
    limit: Type.Optional(int("Maximum libraries to return", 1, MAX_NUM_RESULTS)),
  }, { additionalProperties: false });
}

export function buildLibraryDocsSchema() {
  return Type.Object({
    libraryId: Type.Optional(Type.String({ description: "Canonical library ID, for example /vercel/next.js", minLength: 1, maxLength: 500 })),
    libraryName: Type.Optional(Type.String({ description: "Library name to resolve when libraryId is not known", minLength: 1, maxLength: 500 })),
    query: Type.String({ description: "Specific docs question or coding task", minLength: 1, maxLength: 500 }),
    version: Type.Optional(Type.String({ description: "Optional version/tag to pin, appended as @version", minLength: 1, maxLength: 100 })),
    fast: Type.Optional(Type.Boolean({ description: "Skip LLM reranking for lower latency" })),
    limit: Type.Optional(int("Maximum code and info snippets to return", 1, MAX_NUM_RESULTS)),
  }, { additionalProperties: false });
}

export function buildCodeSearchSchema() {
  return Type.Object({
    query: Type.String({ description: "Code-context query for examples, APIs, setup, migrations, or errors", minLength: 1, maxLength: 2000 }),
    tokensNum: Type.Optional(Type.Union([Type.Literal("dynamic"), int("Target response tokens", 50, MAX_LIMIT)])),
  }, { additionalProperties: false });
}

function buildSearchDescription(_provider: SearchProviderName): string {
  return "Search the web. Use query or queries; returns compact results grouped by query.";
}

function buildFetchDescription(_provider: FetchProviderName): string {
  return "Fetch URL content. Results are cached by URL/options; use offset/limit to read long pages in chunks.";
}


function normalizeQueries(params: Record<string, any>): string[] {
  const raw = Array.isArray(params.queries) ? params.queries : params.query ? [params.query] : [];
  const queries = [...new Set(raw.map((q) => String(q).trim()).filter(Boolean))];
  if (queries.length > MAX_QUERY_COUNT) throw new Error(`Too many queries: maximum is ${MAX_QUERY_COUNT}.`);
  return queries;
}

function normalizeUrls(params: Record<string, any>): string[] {
  return normalizeUrlInput({ url: params.url, urls: params.urls }, MAX_URL_COUNT);
}

export async function fetchWithCache(providerName: FetchProviderName, params: Record<string, any>, urls: string[], signal: AbortSignal | undefined, config: any, onProgress?: (event: FetchProgressEvent) => void) {
  const provider = createFetchProvider(config);
  const offset = parseInteger(params.offset, 0, "offset", 0, MAX_OFFSET);
  const defaultLimit = urls.length > 1 ? MULTI_FETCH_LIMIT : DEFAULT_FETCH_LIMIT;
  const limit = parseInteger(params.limit, defaultLimit, "limit", 1, MAX_LIMIT);
  const refresh = params.refresh === true;

  const pages = new Map<string, { page?: CachedPage; cached: boolean; refreshed: boolean; error?: string }>();
  const cacheKeys = new Map<string, string>();
  const missing: string[] = [];
  for (const url of urls) {
    const cacheKey = buildCacheKey(providerName, url, params, config);
    cacheKeys.set(url, cacheKey);
    const cached = fetchCache.get(cacheKey);
    if (cached && !refresh) {
      pages.set(url, { page: cached, cached: true, refreshed: false });
      onProgress?.({ status: "done", url, note: "cached" });
    } else {
      missing.push(url);
    }
  }

  if (missing.length > 0) {
    for (const url of missing) onProgress?.({ status: "current", url });
    const fetched = await provider.fetch({ ...params, url: undefined, urls: missing }, signal);
    const mapped = mapFetchResults(missing, fetched);
    for (const requestedUrl of missing) {
      const item = mapped.get(requestedUrl);
      if (!item || item.error) {
        const error = item?.error ?? "No content returned.";
        pages.set(requestedUrl, { error, cached: false, refreshed: refresh });
        onProgress?.({ status: "error", url: requestedUrl, error });
        continue;
      }
      const cacheKey = cacheKeys.get(requestedUrl)!;
      const page = fetchCache.set(cacheKey, {
        provider: providerName,
        cacheKey,
        requestedUrl,
        url: item.url || requestedUrl,
        title: item.title,
        content: item.content ?? "",
        format: item.format ?? "markdown",
        metadata: item.metadata,
        fetchedAt: Date.now(),
      });
      pages.set(requestedUrl, { page, cached: false, refreshed: refresh });
      onProgress?.({ status: "done", url: requestedUrl, note: `${page.content.length} chars` });
    }
  }

  return { provider: providerName, results: urls.map((url) => {
    const entry = pages.get(url);
    if (!entry?.page) return { url, error: entry?.error ?? "No content returned." };
    return pageSlice(entry.page, offset, limit, entry.cached, entry.refreshed);
  }) };
}


export function pageSlice(page: CachedPage, offset: number, limit: number, cached: boolean, refreshed: boolean) {
  const total = page.content.length;
  const content = page.content.slice(offset, offset + limit);
  return { url: page.requestedUrl ?? page.url, fetchedUrl: page.url, title: page.title, content, format: page.format, cached, refreshed, range: { offset, limit, returned: content.length, total, truncated: offset > 0 || offset + content.length < total, hasPrevious: offset > 0, hasNext: offset + content.length < total, nextOffset: offset + content.length < total ? offset + content.length : undefined } };
}

export function buildCacheKey(provider: FetchProviderName, url: string, params: Record<string, any>, config?: any): string {
  const canonical = canonicalWebUrl(url);
  const affecting: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    if (["url", "urls", "offset", "limit", "refresh"].includes(key)) continue;
    affecting[key] = params[key];
  }
  for (const [key, value] of Object.entries(fetchConfigDefaults(provider, config))) if (affecting[key] === undefined) affecting[key] = value;
  const scope = providerScope(provider, config);
  return `${provider}\0${scope}\0${JSON.stringify(affecting)}\0${canonical}`;
}

function projectIsTrusted(ctx: { isProjectTrusted?: () => boolean }): boolean {
  return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
}

function runtimeConfig(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  return resolveConfig(
    { providerSearch: pi.getFlag("web-provider-search"), providerFetch: pi.getFlag("web-provider-fetch") },
    cwd,
    process.env,
    { includeProject: projectTrusted },
  );
}

const MAX_OUTPUT_BYTES = 50_000;

export function jsonToolResult(result: unknown) {
  const bounded = boundStructuredResult(result);
  return { content: [{ type: "text" as const, text: JSON.stringify(bounded) }], details: boundedDetails(bounded) };
}

function boundStructuredResult(result: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(result)) <= MAX_OUTPUT_BYTES) return result;

  if (isFetchResult(result)) {
    let low = 0;
    let high = Math.max(...result.results.map((item: any) => typeof item.content === "string" ? item.content.length : 0));
    const emptyContent = fetchResultWithContentLimit(result, 0);
    const boundedEnvelope = limitStrings(emptyContent, 1_000);
    if (Buffer.byteLength(JSON.stringify(boundedEnvelope)) > MAX_OUTPUT_BYTES) {
      return { truncated: true, message: "Fetch metadata exceeded 50KB; retry with fewer URLs." };
    }
    let best: unknown = boundedEnvelope;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = fetchResultWithContentLimit(result, middle);
      if (Buffer.byteLength(JSON.stringify(candidate)) <= MAX_OUTPUT_BYTES) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }

  const compact = limitStrings(result, 1_000);
  if (Buffer.byteLength(JSON.stringify(compact)) <= MAX_OUTPUT_BYTES) return compact;
  return { truncated: true, message: "Structured result exceeded 50KB; refine the request or use smaller limits." };
}

function isFetchResult(value: any): value is { provider?: string; results: any[] } {
  return !!value && Array.isArray(value.results) && value.results.some((item: any) => typeof item?.content === "string" && item?.range);
}

function fetchResultWithContentLimit(value: { provider?: string; results: any[] }, maxChars: number) {
  return {
    ...value,
    results: value.results.map((item: any) => {
      if (typeof item.content !== "string" || !item.range) return item;
      const content = safePrefix(item.content, maxChars);
      const returned = content.length;
      const hasNext = item.range.offset + returned < item.range.total;
      return {
        ...item,
        content,
        range: {
          ...item.range,
          returned,
          truncated: item.range.offset > 0 || hasNext,
          hasNext,
          nextOffset: hasNext ? item.range.offset + returned : undefined,
        },
      };
    }),
  };
}

function safePrefix(value: string, maxChars: number): string {
  let end = Math.min(value.length, maxChars);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end);
}

function limitStrings(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") return safePrefix(value, maxChars);
  if (Array.isArray(value)) return value.map((item) => limitStrings(item, maxChars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, limitStrings(item, maxChars)]));
  return value;
}

function parseInteger(value: unknown, defaultValue: number, name: string, min: number, max: number): number {
  if (value == null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a finite integer between ${min} and ${max}.`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  return requiredString(value, name);
}

function parseTokensNum(value: unknown): "dynamic" | number {
  if (value == null) return "dynamic";
  if (value === "dynamic") return "dynamic";
  return parseInteger(value, 0, "tokensNum", 50, MAX_LIMIT);
}

function fetchConfigDefaults(provider: FetchProviderName, config?: any): Record<string, unknown> {
  if (provider === "markdown_new") return { method: config?.markdownNew?.method ?? "auto", retainImages: config?.markdownNew?.retainImages ?? false };
  if (provider === "firecrawl") return { onlyMainContent: true, format: "markdown" };
  return {};
}

function providerScope(provider: FetchProviderName, config?: any): string {
  const keyMap: Partial<Record<FetchProviderName, string | undefined>> = {
    exa: config?.apiKeys?.exa,
    exa_mcp: config?.apiKeys?.exa,
    tinyfish: config?.apiKeys?.tinyfish,
    firecrawl: config?.apiKeys?.firecrawl,
  };
  const key = keyMap[provider];
  return key ? `key:${createHash("sha256").update(String(key)).digest("hex")}` : "default";
}

function assertProviderUnchanged(tool: string, startup: string, runtime: string) {
  if (startup !== runtime) throw new Error(`${tool} was registered for provider '${startup}' but runtime config resolved '${runtime}'. Restart or reload pi after changing pi-web-kit provider config so tool schemas match the active provider.`);
}

function boundedDetails(value: any): unknown {
  if (value?.queries && Array.isArray(value.queries)) return searchDetails(value);
  if (value?.provider === "context7" && value?.results && Array.isArray(value.results)) return librarySearchDetails(value);
  if (value?.provider === "context7" && value?.codeSnippets && value?.infoSnippets) return libraryDocsDetails(value);
  if (value?.provider === "exa" && typeof value.response === "string") return codeSearchDetails(value);
  if (value?.results && Array.isArray(value.results)) return fetchDetails(value);
  return value;
}

function searchDetails(value: any) {
  return {
    provider: value.provider,
    queries: value.queries.map((q: any) => ({
      query: q.query,
      resultCount: (q.results ?? []).length,
      results: (q.results ?? []).map((r: any) => ({ title: r.title, url: r.url, siteName: r.siteName, position: r.position })),
    })),
  };
}

function librarySearchDetails(value: any) {
  return {
    provider: value.provider,
    libraryName: value.libraryName,
    resultCount: value.results.length,
    results: value.results.map((r: any) => ({ id: r.id, title: r.title, state: r.state, trustScore: r.trustScore, versions: r.versions })),
  };
}

function libraryDocsDetails(value: any) {
  const codeSources = value.codeSnippets.map((s: any) => s.codeId);
  const infoSources = value.infoSnippets.map((s: any) => s.pageId);
  return {
    provider: value.provider,
    libraryId: value.libraryId,
    query: value.query,
    codeSnippetCount: value.codeSnippets.length,
    infoSnippetCount: value.infoSnippets.length,
    sources: [...codeSources, ...infoSources].filter(Boolean).slice(0, MAX_NUM_RESULTS),
  };
}

function codeSearchDetails(value: any) {
  return {
    provider: value.provider,
    query: value.query,
    resultsCount: value.resultsCount,
    outputTokens: value.outputTokens,
    requestId: value.requestId,
  };
}

function fetchDetails(value: any) {
  return {
    provider: value.provider,
    results: value.results.map((r: any) => ({
      url: r.url,
      fetchedUrl: r.fetchedUrl,
      title: r.title,
      format: r.format,
      cached: r.cached,
      refreshed: r.refreshed,
      range: r.range,
      error: r.error,
    })),
  };
}

function createProgress(kind: ProgressKind, provider: string, labels: string[]): WebProgress {
  return { kind, provider, total: labels.length, completed: 0, items: labels.map((label) => ({ label, status: "pending" })) };
}

function markProgressCurrent(progress: WebProgress, label: string) {
  const item = progress.items.find((i) => i.label === label);
  if (item && item.status === "pending") item.status = "current";
}

function markProgressDone(progress: WebProgress, label: string, note?: string) {
  const item = progress.items.find((i) => i.label === label);
  if (!item) return;
  item.status = "done";
  item.note = note;
  progress.completed++;
}

function markProgressError(progress: WebProgress, label: string, error?: string) {
  const item = progress.items.find((i) => i.label === label);
  if (!item) return;
  item.status = "error";
  item.error = error;
  progress.completed++;
}

function updateFetchProgress(progress: WebProgress, event: FetchProgressEvent) {
  switch (event.status) {
    case "current":
      markProgressCurrent(progress, event.url);
      break;
    case "done":
      markProgressDone(progress, event.url, event.note);
      break;
    case "error":
      markProgressError(progress, event.url, event.error);
      break;
  }
}

function emitProgress(onUpdate: ((patch: any) => void) | undefined, progress: WebProgress) {
  const verb = progress.kind === "search" ? "Searching web" : "Fetching pages";
  onUpdate?.({
    content: [{ type: "text", text: `${verb}: ${progress.completed}/${progress.total}` }],
    details: { progress: cloneProgress(progress) },
  });
}

function cloneProgress(progress: WebProgress): WebProgress {
  return { ...progress, items: progress.items.map((item) => ({ ...item })) };
}

function renderWebCall(kind: ProgressKind, args: Record<string, any>, theme: any): string {
  const title = kind === "search" ? "web_search" : "web_fetch";
  const labels = kind === "search" ? normalizeLabels(args.query, args.queries) : normalizeLabels(args.url, args.urls);
  const summary = labels.length > 1 ? `${labels.length} ${kind === "search" ? "queries" : "URLs"}` : (labels[0] ?? "…");
  return `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("accent", truncateMiddle(summary, 96))}`;
}

function renderWebResult(kind: ProgressKind, result: any, { expanded, isPartial }: any, theme: any, context: any) {
  const progress = result.details?.progress as WebProgress | undefined;
  if (isPartial && progress) {
    startSpinner(context);
    return new Text(renderProgress(progress, theme, spinnerFrame(context), expanded), 0, 0);
  }
  stopSpinner(context);

  const details = result.details as any;
  if (kind === "search" && details?.queries) {
    const total = details.queries.reduce((sum: number, q: any) => sum + (q.resultCount ?? q.results?.length ?? 0), 0);
    let text = `${theme.fg("success", "✅ Web search complete")} ${theme.fg("muted", `${details.queries.length}/${details.queries.length}`)}\n   results: ${total} total`;
    if (expanded) for (const q of details.queries) text += `\n   ✓ ${theme.fg("accent", quote(q.query))} ${theme.fg("muted", `${q.resultCount ?? q.results?.length ?? 0} results`)}`;
    return new Text(text, 0, 0);
  }
  if (kind === "fetch" && details?.results) {
    const ok = details.results.filter((r: any) => !r.error).length;
    const failed = details.results.length - ok;
    let text = failed > 0 ? `${theme.fg("warning", "⚠️ Fetch complete")} ${ok}/${details.results.length} succeeded` : `${theme.fg("success", details.results.length === 1 ? "✅ Page fetched" : "✅ Pages fetched")} ${theme.fg("muted", `${ok}/${details.results.length}`)}`;
    if (expanded) for (const r of details.results) text += `\n   ${r.error ? theme.fg("error", "✕") : theme.fg("success", "✓")} ${theme.fg("accent", truncateMiddle(r.url, 100))}${r.error ? theme.fg("error", ` ${r.error}`) : theme.fg("muted", ` ${r.range?.returned ?? 0}/${r.range?.total ?? 0} chars${r.cached ? " cached" : ""}`)}`;
    return new Text(text, 0, 0);
  }
  const content = result.content?.find?.((c: any) => c.type === "text")?.text ?? "";
  return new Text(content, 0, 0);
}

function renderProgress(progress: WebProgress, theme: any, spinner: string, expanded: boolean): string {
  const isSearch = progress.kind === "search";
  const verb = isSearch ? "Searching web" : progress.total === 1 ? "Fetching page" : "Fetching pages";
  let text = `${isSearch ? "🔎" : "🌐"} ${verb}${progress.total > 1 ? `  ${progressBar(progress.completed, progress.total)} ${progress.completed}/${progress.total}` : "…"}`;
  const visible = expanded ? progress.items : progress.items.slice(0, 6);
  const iconMap: Record<string, string> = {
    done: theme.fg("success", "✓"),
    error: theme.fg("error", "✕"),
    current: theme.fg("warning", spinner),
    pending: theme.fg("muted", "·"),
  };
  for (const item of visible) {
    const icon = iconMap[item.status] ?? theme.fg("muted", "·");
    const note = item.error ? theme.fg("error", ` ${item.error}`) : item.note ? theme.fg("muted", ` ${item.note}`) : "";
    text += `\n   ${icon} ${theme.fg(item.status === "pending" ? "muted" : "accent", quote(truncateMiddle(item.label, 100)))}${note}`;
  }
  if (!expanded && progress.items.length > visible.length) text += `\n   ${theme.fg("muted", `… +${progress.items.length - visible.length} more`)}`;
  return text;
}

function startSpinner(context: any) {
  if (context.state?.spinnerTimer) return;
  context.state.spinnerIndex = context.state.spinnerIndex ?? 0;
  context.state.spinnerTimer = setInterval(() => {
    context.state.spinnerIndex = ((context.state.spinnerIndex ?? 0) + 1) % SPINNER.length;
    context.invalidate?.();
  }, 140);
}

function stopSpinner(context: any) {
  if (!context.state?.spinnerTimer) return;
  clearInterval(context.state.spinnerTimer);
  context.state.spinnerTimer = undefined;
}

const SPINNER = ["◐", "◓", "◑", "◒"];

function spinnerFrame(context: any): string {
  return SPINNER[context.state?.spinnerIndex ?? 0] ?? SPINNER[0];
}

function progressBar(completed: number, total: number): string {
  const width = 16;
  const filled = total <= 0 ? 0 : Math.round((completed / total) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function normalizeLabels(single: unknown, multiple: unknown): string[] {
  const raw = Array.isArray(multiple) ? multiple : single ? [single] : [];
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

function quote(value: string): string {
  return `"${value}"`;
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
