import { asSnippet, mapConcurrent, normalizeUrls, requestJson } from "../http.js";
import { DEFAULT_NUM_RESULTS, FETCH_CONCURRENCY } from "../limits.js";
import type { FetchInput, FetchProvider, SearchInput, SearchProvider, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";

export class FirecrawlProvider implements SearchProvider, FetchProvider {
  private key: string;
  constructor(config: WebKitConfig) { this.key = requireKey(config, "firecrawl"); }
  private headers() { return { "content-type": "application/json", authorization: `Bearer ${this.key}` }; }

  async search(input: SearchInput, signal?: AbortSignal) {
    const data = await requestJson<any>("https://api.firecrawl.dev/v2/search", {
      method: "POST", headers: this.headers(), signal, timeoutMs: 45000,
      body: JSON.stringify({
        query: input.query,
        limit: input.numResults ?? DEFAULT_NUM_RESULTS,
        location: input.location,
        country: input.country,
        includeDomains: input.includeDomains,
        excludeDomains: input.excludeDomains,
        categories: input.categories,
        tbs: input.tbs,
        scrapeOptions: input.scrapeOptions ?? (input.scrape === true ? { formats: ["markdown"] } : undefined),
      }),
    });
    const list = data.data?.web ?? data.web ?? data.data ?? [];
    return { provider: "firecrawl" as const, query: input.query, results: list.map((r: any, i: number) => ({
      title: r.title, url: r.url, snippet: asSnippet(r.description ?? r.markdown ?? r.content), siteName: r.siteName, position: i + 1,
    })).filter((r: any) => r.url) };
  }

  async fetch(input: FetchInput, signal?: AbortSignal) {
    const urls = normalizeUrls(input);
    const results = await mapConcurrent(urls, FETCH_CONCURRENCY, async (url) => {
      try {
        const format = input.format ?? "markdown";
        const formats = [format];
        const data = await requestJson<any>("https://api.firecrawl.dev/v2/scrape", {
          method: "POST", headers: this.headers(), signal, timeoutMs: 90000,
          body: JSON.stringify({
            url,
            formats,
            onlyMainContent: input.onlyMainContent ?? true,
            waitFor: input.waitFor,
            mobile: input.mobile,
            location: input.location,
            maxAge: input.maxAge,
          }),
        });
        const d = data.data ?? data;
        const selected = selectFirecrawlContent(d, format);
        const content = stringifyContent(selected);
        return { url: d.url ?? url, content, format, title: d.metadata?.title, metadata: d.metadata ?? d };
      } catch (e) {
        return { url, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { provider: "firecrawl" as const, results };
  }
}

function selectFirecrawlContent(data: any, format: string): unknown {
  switch (format) {
    case "html":
      return data.html;
    case "json":
      return data.json;
    default:
      return data.markdown;
  }
}

function stringifyContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return value == null ? undefined : JSON.stringify(value, null, 2);
}
