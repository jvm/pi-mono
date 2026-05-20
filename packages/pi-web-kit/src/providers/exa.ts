import { asSnippet, normalizeUrls, requestJson } from "../http.js";
import { DEFAULT_NUM_RESULTS } from "../limits.js";
import { urlsMatch } from "../urls.js";
import type { FetchInput, FetchProvider, SearchInput, SearchProvider, WebFetchResult, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";
import { applyExaFetchFallbacks } from "./fallback.js";

export class ExaProvider implements SearchProvider, FetchProvider {
  private key: string;
  constructor(private config: WebKitConfig) { this.key = requireKey(config, "exa"); }

  async search(input: SearchInput, signal?: AbortSignal) {
    const body = {
      query: input.query,
      numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
      contents: input.contents ?? { highlights: true },
      includeDomains: input.includeDomains,
      excludeDomains: input.excludeDomains,
      startPublishedDate: input.startPublishedDate,
      endPublishedDate: input.endPublishedDate,
      startCrawlDate: input.startCrawlDate,
      endCrawlDate: input.endCrawlDate,
      type: input.type,
      category: input.category,
    };
    const data = await requestJson<any>("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.key },
      body: JSON.stringify(body),
      signal,
      timeoutMs: 30000,
    });
    return {
      provider: "exa" as const,
      query: input.query,
      results: (data.results ?? []).map((r: any, i: number) => ({
        title: r.title,
        url: r.url,
        snippet: asSnippet(r.highlights ?? r.summary ?? r.text),
        siteName: r.author ?? r.publishedDate,
        position: i + 1,
      })).filter((r: any) => r.url),
    };
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<WebFetchResult> {
    const urls = normalizeUrls(input);
    if (urls.length === 0) return { provider: "exa", results: [] };
    const data = await requestJson<any>("https://api.exa.ai/contents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.key },
      body: JSON.stringify({ urls, text: true, highlights: false }),
      signal,
      timeoutMs: 45000,
    });
    const list = data.results ?? [];
    const primary: WebFetchResult = { provider: "exa", results: urls.map((url, i) => {
      const r: any = list.find((item: any) => urlsMatch(item.url, url)) ?? list[i];
      if (!r) return { url, error: "No content returned by Exa contents endpoint." };
      return { url: r.url ?? url, title: r.title, content: r.text ?? r.summary ?? "", format: "markdown" as const, metadata: r };
    }) };
    return applyExaFetchFallbacks(this.config, input, urls, primary, signal);
  }
}
