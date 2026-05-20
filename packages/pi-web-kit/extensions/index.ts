import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fetchCache, type CachedPage } from "../src/cache.js";
import { resolveConfig } from "../src/config.js";
import { DEFAULT_FETCH_LIMIT, DEFAULT_NUM_RESULTS, MAX_LIMIT, MAX_NUM_RESULTS, MAX_OFFSET, MAX_QUERY_COUNT, MAX_URL_COUNT, MULTI_FETCH_LIMIT } from "../src/limits.js";
import { truncateText } from "../src/http.js";
import { createFetchProvider, createSearchProvider } from "../src/providers/index.js";
import { mapFetchResults } from "../src/providers/fallback.js";
import type { FetchProviderName, SearchProviderName, WebFetchResult } from "../src/types.js";
import { canonicalWebUrl, normalizeUrlInput } from "../src/urls.js";

const PACKAGE_NAME = "pi-web-kit";
const INSTALL_TELEMETRY_URL = "https://mocito.dev/api/report-install";
const INSTALL_TELEMETRY_TIMEOUT_MS = 5000;

type InstallTelemetryState = { lastReportedVersion?: string };

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

  const startupConfig = resolveConfig({
    providerSearch: pi.getFlag("web-provider-search"),
    providerFetch: pi.getFlag("web-provider-fetch"),
  });

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

      const config = resolveConfig({ providerSearch: pi.getFlag("web-provider-search") }, ctx.cwd);
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
      const text = truncateText(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }], details: boundedDetails(result) };
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

      const config = resolveConfig({ providerFetch: pi.getFlag("web-provider-fetch") }, ctx.cwd);
      assertProviderUnchanged("web_fetch", startupConfig.provider_fetch, config.provider_fetch);
      const progress = createProgress("fetch", config.provider_fetch, urls);
      const result = await fetchWithCache(config.provider_fetch, params, urls, signal, config, (event) => {
        if (event.status === "current") markProgressCurrent(progress, event.url);
        else if (event.status === "done") markProgressDone(progress, event.url, event.note);
        else if (event.status === "error") markProgressError(progress, event.url, event.error);
        emitProgress(onUpdate, progress);
      });
      const text = truncateText(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }], details: boundedDetails(result) };
    },
    renderCall(args, theme) {
      return new Text(renderWebCall("fetch", args as Record<string, any>, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderWebResult("fetch", result, options, theme, context);
    },
  });
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

function buildSearchDescription(provider: SearchProviderName): string {
  return `Search the web with startup provider '${provider}'. Use query or queries; returns compact results grouped by query. Restart/reload pi after provider changes.`;
}

function buildFetchDescription(provider: FetchProviderName): string {
  return `Fetch URL content with startup provider '${provider}'. Results are cached by URL/options; use offset/limit to read long pages in chunks. Restart/reload pi after provider changes.`;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isInstallTelemetryEnabled(): boolean {
  if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return false;
  if (isTruthyEnvFlag(process.env.CI) || isTruthyEnvFlag(process.env.GITHUB_ACTIONS)) return false;
  if (process.env.PI_TELEMETRY !== undefined) return isTruthyEnvFlag(process.env.PI_TELEMETRY);
  const settings = readJsonFile(join(getAgentDir(), "settings.json")) as { enableInstallTelemetry?: unknown };
  return settings.enableInstallTelemetry !== false;
}

function getPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.length > 0 ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getInstallTelemetryUserAgent(version: string): string {
  const runtimeVersions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  const runtime = runtimeVersions.bun ? `bun/${runtimeVersions.bun}` : `node/${process.version}`;
  return `${PACKAGE_NAME}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

export async function reportInstallTelemetry(): Promise<void> {
  try {
    if (!isInstallTelemetryEnabled()) return;

    const version = getPackageVersion();
    const telemetryDir = join(getAgentDir(), "extensions");
    const statePath = join(telemetryDir, "pi-web-kit-install.json");
    const state = readJsonFile(statePath) as InstallTelemetryState;
    if (state.lastReportedVersion === version) return;

    await mkdir(telemetryDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify({ lastReportedVersion: version }, null, 2)}\n`);

    const params = new URLSearchParams({ tool: PACKAGE_NAME, version });
    await fetch(`${INSTALL_TELEMETRY_URL}?${params.toString()}`, {
      headers: { "User-Agent": getInstallTelemetryUserAgent(version) },
      signal: AbortSignal.timeout(INSTALL_TELEMETRY_TIMEOUT_MS),
    });
  } catch {
    // Best-effort install telemetry: ignore settings, filesystem, and network failures.
  }
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
  return { url: page.requestedUrl ?? page.url, fetchedUrl: page.url, title: page.title, content, format: page.format, cached, refreshed, cacheKey: page.cacheKey, range: { offset, limit, returned: content.length, total, truncated: offset > 0 || offset + content.length < total, hasPrevious: offset > 0, hasNext: offset + content.length < total } };
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

function parseInteger(value: unknown, defaultValue: number, name: string, min: number, max: number): number {
  if (value == null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a finite integer between ${min} and ${max}.`);
  return value;
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
  return key ? `key:${String(key).slice(0, 8)}` : "default";
}

function assertProviderUnchanged(tool: string, startup: string, runtime: string) {
  if (startup !== runtime) throw new Error(`${tool} was registered for provider '${startup}' but runtime config resolved '${runtime}'. Restart or reload pi after changing pi-web-kit provider config so tool schemas match the active provider.`);
}

function boundedDetails(value: any): unknown {
  if (value?.queries && Array.isArray(value.queries)) return { provider: value.provider, queries: value.queries.map((q: any) => ({ query: q.query, resultCount: (q.results ?? []).length, results: (q.results ?? []).map((r: any) => ({ title: r.title, url: r.url, siteName: r.siteName, position: r.position })) })) };
  if (value?.results && Array.isArray(value.results)) return { provider: value.provider, results: value.results.map((r: any) => ({ url: r.url, fetchedUrl: r.fetchedUrl, title: r.title, format: r.format, cached: r.cached, refreshed: r.refreshed, cacheKey: r.cacheKey, range: r.range, error: r.error })) };
  return value;
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
