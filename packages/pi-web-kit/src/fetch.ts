import { createHmac, randomBytes } from "node:crypto";
import { fetchCache, type CachedPage } from "./cache.js";
import { DEFAULT_FETCH_LIMIT, MAX_FETCH_LINKS, MAX_LIMIT, MAX_OFFSET, MAX_URL_LENGTH, MULTI_FETCH_LIMIT, MAX_FIND_TERM, MAX_FIND_MATCHES, FIND_CONTEXT } from "./limits.js";
import { publicPageError, redactText } from "./output.js";
import { createFetchProvider } from "./providers/index.js";
import { exaFetchMaxAgeHours } from "./providers/exa-contract.js";
import { mapFetchResults } from "./providers/fallback.js";
import type { FetchProviderName, WebKitConfig } from "./types.js";
import { canonicalWebUrl, normalizeWebUrl } from "./urls.js";
import { parseInteger } from "./validation.js";
import { shareFetch } from "./coordinator.js";

export type FetchProgressEvent = { status: "current" | "done" | "error"; url: string; note?: string; error?: string };

// Cache identities are process-local, not password verifiers. A random HMAC
// key keeps account fingerprints stable only for this in-memory cache and
// prevents offline guessing from an accidentally disclosed fingerprint.
const cacheScopeKey = randomBytes(32);

export async function fetchWithCache(providerName: FetchProviderName, params: Record<string, any>, urls: string[], signal: AbortSignal | undefined,
  config: WebKitConfig, onProgress?: (event: FetchProgressEvent) => void) {
  params = structuredClone(params);
  urls = [...urls];
  signal?.throwIfAborted();
  if (providerName === "exa") exaFetchMaxAgeHours(params);
  const secrets = Object.values(config.apiKeys);
  const provider = createFetchProvider(config);
  const offset = parseInteger(params.offset, 0, "offset", 0, MAX_OFFSET);
  const limit = parseInteger(params.limit, urls.length > 1 ? MULTI_FETCH_LIMIT : DEFAULT_FETCH_LIMIT, "limit", 1, MAX_LIMIT);
  const refresh = params.refresh === true;
  const maxAgeMs = localCacheMaxAge(providerName, params);
  if (params.find !== undefined) {
    if (typeof params.find !== "string" || !params.find.length || params.find.length > MAX_FIND_TERM) throw new Error("Invalid find term.");
    if (params.offset !== undefined || params.limit !== undefined || params.refresh !== undefined) throw new Error("find cannot combine with offset, limit or refresh.");
    const from = parseInteger(params.findFrom, 0, "findFrom", 0, MAX_OFFSET);
    return { provider: providerName, results: urls.map(url => {
      const page = fetchCache.get(buildCacheKey(providerName, url, params, config));
      if (!page || (maxAgeMs != null && (maxAgeMs === 0 || Date.now() - page.fetchedAt > maxAgeMs))) {
        return { url, error: "Cached content unavailable or expired; fetch this URL first." };
      }
      const content = redactText(page.content, secrets);
      // Escaping the complete term makes this a bounded literal, never caller regex.
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const pattern = new RegExp(params.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), params.findCaseSensitive === false ? "giu" : "gu");
      pattern.lastIndex = from;
      const matches = [];
      let count = 0;
      let nextFrom: number | undefined;
      const max = Math.max(1, Math.floor(MAX_FIND_MATCHES / urls.length));
      for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
        // Unicode RegExp can rewind a start inside a surrogate pair. The
        // caller's continuation is still an exact UTF-16 lower bound.
        if (match.index < from) continue;
        count++;
        if (matches.length === max) { nextFrom ??= match.index; continue; }
        const start = Math.max(0, match.index - FIND_CONTEXT);
        const end = Math.min(content.length, match.index + match[0].length + FIND_CONTEXT);
        matches.push({ offset: match.index, length: match[0].length, excerptOffset: start, excerpt: content.slice(start, end) });
      }
      return { url, fetchedUrl: page.url, cached: true as const,
        find: { term: params.find, caseSensitive: params.findCaseSensitive !== false, units: "UTF-16" as const,
          from, scanned: content.length, count, omittedMatchCount: count - matches.length, matches,
          ...(nextFrom === undefined ? {} : { nextFrom }) } };
    }) };
  }
  if (params.findFrom !== undefined || params.findCaseSensitive !== undefined) throw new Error("Finder options require find.");
  const pages = new Map<string, { page?: CachedPage; cached: boolean; refreshed: boolean; error?: string }>();
  const cacheKeys = new Map<string, string>();
  const missing: string[] = [];
  for (const url of urls) {
    const cacheKey = buildCacheKey(providerName, url, params, config);
    cacheKeys.set(url, cacheKey);
    const cached = fetchCache.get(cacheKey);
    if (cached && !refresh && (maxAgeMs == null || (maxAgeMs > 0 && Date.now() - cached.fetchedAt <= maxAgeMs))) {
      pages.set(url, { page: cached, cached: true, refreshed: false });
      onProgress?.({ status: "done", url, note: "cached" });
    } else {
      missing.push(url);
    }
  }
  if (missing.length) {
    for (const url of missing) onProgress?.({ status: "current", url });
    // Collect newly owned misses in this microtask into one provider batch.
    // Sharing remains per URL, whereas HTTP admission counts provider requests.
    const pending: Array<{ url: string; signal: AbortSignal; resolve: (value: any[]) => void; reject: (error: unknown) => void }> = [];
    const batch = (url: string, sharedSignal: AbortSignal): Promise<any[]> => new Promise((resolve, reject) => {
      pending.push({ url, signal: sharedSignal, resolve, reject });
      if (pending.length !== 1) return;
      queueMicrotask(async () => {
        const eligible = pending.filter(item => !item.signal.aborted);
        for (const item of pending) if (item.signal.aborted) item.reject(new Error("Web tool cancelled."));
        const controller = new AbortController();
        const cancel = () => { if (eligible.every(item => item.signal.aborted)) controller.abort(); };
        for (const item of eligible) item.signal.addEventListener("abort", cancel, { once: true });
        try {
          cancel();
          controller.signal.throwIfAborted();
          const requested = eligible.map(item => item.url);
          const result = await provider.fetch({ ...params, url: undefined, urls: requested }, controller.signal);
          controller.signal.throwIfAborted();
          const mapped = mapFetchResults(requested, result);
          for (const item of eligible) item.resolve(mapped.has(item.url) ? [mapped.get(item.url)] : []);
        } catch (error) { for (const item of eligible) item.reject(error); }
        finally { for (const item of eligible) item.signal.removeEventListener("abort", cancel); }
      });
    });
    const fetched = { provider: providerName, results: (await Promise.all(missing.map(url =>
      shareFetch(cacheKeys.get(url)! + `\0refresh:${refresh}`, signal, async sharedSignal => {
        return batch(url, sharedSignal);
      })))).flat() };
    signal?.throwIfAborted();
    const mapped = mapFetchResults(missing, fetched);
    for (const requestedUrl of missing) {
      const item = mapped.get(requestedUrl);
      if (!item || item.error || typeof item.content !== "string" || !item.content.trim()) {
        const error = publicPageError(item?.error ?? "No content returned.");
        pages.set(requestedUrl, { error, cached: false, refreshed: refresh });
        onProgress?.({ status: "error", url: requestedUrl, error });
        continue;
      }
      const cacheKey = cacheKeys.get(requestedUrl)!;
      const page = fetchCache.set(cacheKey, {
        provider: providerName, cacheKey, requestedUrl, url: item.url || requestedUrl, title: item.title,
        content: redactText(item.content, secrets), format: item.format ?? "markdown", fetchedAt: Date.now(),
        // Raw provider metadata is not used by range reads and must not occupy
        // the cache. Retain only validated link fields requested by the caller.
        ...(params.links === true ? linkFields(item.links, "links") : {}),
        ...(params.imageLinks === true ? linkFields(item.imageLinks, "imageLinks") : {}),
      });
      pages.set(requestedUrl, { page, cached: false, refreshed: refresh });
      onProgress?.({ status: "done", url: requestedUrl, note: `${page.content.length} chars` });
    }
  }
  return { provider: providerName, results: urls.map(url => {
    const entry = pages.get(url);
    if (!entry?.page) return { url, error: entry?.error ?? "No content returned." };
    // Mask before range boundaries, including pages cached before a key change.
    return pageSlice({ ...entry.page, content: redactText(entry.page.content, secrets) }, offset, limit, entry.cached, entry.refreshed);
  }) };
}

function linkFields(value: unknown, field: "links" | "imageLinks") {
  if (!Array.isArray(value)) return {};
  const links: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (links.length === MAX_FETCH_LINKS) break;
    if (typeof item !== "string") continue;
    try {
      normalizeWebUrl(item); // Reject credentials and non-HTTP(S) schemes.
      const url = new URL(item.trim()).toString(); // Preserve useful fragment links.
      if (url.length > MAX_URL_LENGTH || seen.has(url)) continue;
      seen.add(url);
      links.push(url);
    } catch { /* Invalid links count as omitted, never become model instructions. */ }
  }
  const omitted = value.length - links.length;
  return { [field]: links, ...(omitted ? { [field === "links" ? "omittedLinkCount" : "omittedImageLinkCount"]: omitted } : {}) };
}

function localCacheMaxAge(provider: FetchProviderName, params: Record<string, any>): number | undefined {
  if (params.maxAgeMs != null) return parseInteger(params.maxAgeMs, 0, "maxAgeMs", 0);
  if (provider === "exa" && typeof params.maxAgeHours === "number" && params.maxAgeHours >= 0) return params.maxAgeHours * 3_600_000;
  if (provider === "tinyfish" && typeof params.ttl === "number") return params.ttl * 1_000;
  if (provider === "firecrawl" && typeof params.maxAge === "number") return params.maxAge;
  return undefined;
}

export function pageSlice(page: CachedPage, offset: number, limit: number, cached: boolean, refreshed: boolean) {
  const total = page.content.length;
  const content = page.content.slice(offset, offset + limit);
  return {
    url: page.requestedUrl ?? page.url, fetchedUrl: page.url, title: page.title, content, format: page.format, cached, refreshed,
    ...(page.links ? { links: page.links, omittedLinkCount: page.omittedLinkCount } : {}),
    ...(page.imageLinks ? { imageLinks: page.imageLinks, omittedImageLinkCount: page.omittedImageLinkCount } : {}),
    range: { offset, limit, returned: content.length, total, truncated: offset > 0 || offset + content.length < total,
      hasPrevious: offset > 0, hasNext: offset + content.length < total, nextOffset: offset + content.length < total ? offset + content.length : undefined },
  };
}

export function buildCacheKey(provider: FetchProviderName, url: string, params: Record<string, any>, config?: Partial<WebKitConfig>): string {
  const affecting: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    if (!["url", "urls", "offset", "limit", "refresh", "find", "findFrom", "findCaseSensitive"].includes(key)) affecting[key] = params[key];
  }
  // refresh overrides cached-only Exa mode. Do not let that live/fallback
  // response populate the key used by a later genuinely cached-only call.
  if (provider === "exa" && params.refresh === true && params.maxAgeHours === -1) affecting.maxAgeHours = 0;
  for (const [key, value] of Object.entries(fetchConfigDefaults(provider, config))) if (affecting[key] === undefined) affecting[key] = value;
  return `${provider}\0${providerScope(provider, config)}\0${JSON.stringify(affecting)}\0${canonicalWebUrl(url)}`;
}

function fetchConfigDefaults(provider: FetchProviderName, config?: Partial<WebKitConfig>): Record<string, unknown> {
  if (provider === "markdown_new") return { method: config?.markdownNew?.method ?? "auto", retainImages: config?.markdownNew?.retainImages ?? false };
  if (provider === "firecrawl") return { onlyMainContent: true, format: "markdown" };
  // Exa may use any configured fallback; its cache must also follow their
  // account and extraction-default changes.
  if (provider === "exa") return { fallbackMarkdownNew: fetchConfigDefaults("markdown_new", config) };
  return {};
}

function providerScope(provider: FetchProviderName, config?: Partial<WebKitConfig>): string {
  const keys = config?.apiKeys;
  const key = provider === "exa" ? JSON.stringify([keys?.exa, keys?.tinyfish, keys?.firecrawl])
    : provider === "tinyfish" ? keys?.tinyfish : provider === "firecrawl" ? keys?.firecrawl : undefined;
  // codeql[js/insufficient-password-hash] Ephemeral keyed cache identity, never a stored password verifier; the random HMAC key stays in this process.
  return key ? `key:${createHmac("sha256", cacheScopeKey).update(key).digest("hex")}` : "default";
}
