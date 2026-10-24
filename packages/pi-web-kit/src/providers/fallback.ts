import type { FetchInput, FetchProvider, FetchProviderName, WebFetchResult, WebKitConfig } from "../types.js";
import { urlsMatch } from "../urls.js";
import { FirecrawlProvider } from "./firecrawl.js";
import { MarkdownNewProvider } from "./markdown-new.js";
import { TinyFishProvider } from "./tinyfish.js";
import { exaFetchMaxAgeHours } from "./exa-contract.js";

type FetchPage = WebFetchResult["results"][number];

export function isMissingExaCrawlResult(page: FetchPage | undefined): boolean {
  return !page || !!page.error || typeof page.content !== "string" || !page.content.trim();
}

export async function applyExaFetchFallbacks(
  config: WebKitConfig,
  input: FetchInput,
  urls: string[],
  primary: WebFetchResult,
  signal?: AbortSignal,
): Promise<WebFetchResult> {
  const mappedPrimary = mapFetchResults(urls, primary);
  const results = urls.map(url => {
    const page = mappedPrimary.get(url);
    return isMissingExaCrawlResult(page)
      ? { url, requestedUrl: url, error: page?.error || "No content returned by Exa." }
      : page!;
  });
  let missing = urls.filter((url, i) => isMissingExaCrawlResult(results[i]));
  if (missing.length === 0) return { ...primary, results };
  const hours = exaFetchMaxAgeHours(input);
  // Other backends cannot enforce Exa's cached-only policy.
  if (hours === -1) return { ...primary, results };
  const maxAgeMs = hours == null ? input.maxAgeMs : hours * 3_600_000;

  for (const { name, provider } of fallbackProviders(config)) {
    if (missing.length === 0) break;
    signal?.throwIfAborted();
    // markdown.new exposes no freshness control. Do not weaken an explicit
    // freshness bound, including refresh:true, by silently using its defaults.
    if (name === "markdown_new" && maxAgeMs != null) continue;
    let fetched: WebFetchResult;
    try {
      fetched = await provider.fetch({ urls: missing, maxAgeMs, refresh: input.refresh }, signal);
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    const mapped = mapFetchResults(missing, fetched);
    missing = missing.filter((url) => {
      const item = mapped.get(url);
      if (!hasUsableContent(item)) return true;
      const index = urls.findIndex((candidate) => candidate === url);
      results[index] = {
        ...item,
        url: item.url,
        requestedUrl: url,
        metadata: {
          ...(isRecord(item?.metadata) ? item.metadata : {}),
          fallbackProvider: name,
          fallbackFrom: primary.provider,
          fetchedUrl: item?.url,
        },
      };
      return false;
    });
  }

  return { ...primary, results };
}

function fallbackProviders(config: WebKitConfig): Array<{ name: FetchProviderName; provider: FetchProvider }> {
  const providers: Array<{ name: FetchProviderName; provider: FetchProvider }> = [];
  if (config.apiKeys.tinyfish) providers.push({ name: "tinyfish", provider: new TinyFishProvider(config) });
  if (config.apiKeys.firecrawl) providers.push({ name: "firecrawl", provider: new FirecrawlProvider(config) });
  providers.push({ name: "markdown_new", provider: new MarkdownNewProvider(config) });
  return providers;
}

export function mapFetchResults(requested: string[], fetched: WebFetchResult): Map<string, FetchPage> {
  const out = new Map<string, FetchPage>();
  const remaining = [...(fetched.results ?? [])];
  for (const url of requested) {
    const index = remaining.findIndex((item) => urlsMatch(item.requestedUrl ?? item.url, url));
    if (index >= 0) out.set(url, remaining.splice(index, 1)[0]);
  }
  // Providers may not echo the requested URL. Assign each unmatched result at
  // most once, after exact matches. Never repurpose an explicitly bound result.
  for (const url of requested) {
    if (out.has(url)) continue;
    const index = remaining.findIndex(item => item.requestedUrl == null);
    if (index >= 0) out.set(url, remaining.splice(index, 1)[0]);
  }
  return out;
}

function hasUsableContent(item: FetchPage | undefined): item is FetchPage {
  return !!item && !item.error && typeof item.content === "string" && item.content.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
