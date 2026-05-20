import type { FetchInput, FetchProvider, FetchProviderName, WebFetchResult, WebKitConfig } from "../types.js";
import { urlsMatch } from "../urls.js";
import { FirecrawlProvider } from "./firecrawl.js";
import { MarkdownNewProvider } from "./markdown-new.js";
import { TinyFishProvider } from "./tinyfish.js";

type FetchPage = WebFetchResult["results"][number];

export function isMissingExaCrawlResult(page: FetchPage | undefined): boolean {
  if (!page) return true;
  const message = [page.error, page.content].filter((v): v is string => typeof v === "string").join("\n");
  if (!message.trim()) return true;
  return /\b(no crawl results?|not crawled|crawl(?:ed)? content (?:is )?(?:not )?(?:available|found)|no content returned by exa|no results? found)\b/i.test(message);
}

export async function applyExaFetchFallbacks(
  config: WebKitConfig,
  input: FetchInput,
  urls: string[],
  primary: WebFetchResult,
  signal?: AbortSignal,
): Promise<WebFetchResult> {
  const results = urls.map((url, i) => primary.results.find((item) => urlsMatch(item.url, url)) ?? primary.results[i] ?? { url, error: "No content returned by Exa." });
  let missing = urls.filter((url, i) => isMissingExaCrawlResult(results[i]));
  if (missing.length === 0) return { ...primary, results };

  for (const { name, provider } of fallbackProviders(config)) {
    if (missing.length === 0) break;
    let fetched: WebFetchResult;
    try {
      fetched = await provider.fetch({ ...input, url: undefined, urls: missing }, signal);
    } catch {
      continue;
    }
    const mapped = mapFetchResults(missing, fetched);
    missing = missing.filter((url) => {
      const item = mapped.get(url);
      if (!hasUsableContent(item)) return true;
      const index = urls.findIndex((candidate) => candidate === url);
      results[index] = {
        ...item,
        url,
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
    const index = remaining.findIndex((item) => urlsMatch(item.url, url));
    if (index >= 0) out.set(url, remaining.splice(index, 1)[0]);
  }
  // providers may not echo back the canonical URL; fall back to positional match
  requested.forEach((url, index) => { if (!out.has(url) && fetched.results?.[index]) out.set(url, fetched.results[index]); });
  return out;
}

function hasUsableContent(item: FetchPage | undefined): item is FetchPage {
  return !!item && !item.error && typeof item.content === "string" && item.content.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
