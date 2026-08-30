import { asSnippet, asText, normalizeUrls, requestJson, withoutContent } from "../http.js";
import { DEFAULT_NUM_RESULTS } from "../limits.js";
import { urlsMatch } from "../urls.js";
import type { ExaCodeInput, ExaCodeResult, FetchInput, FetchProvider, SearchInput, SearchProvider, WebFetchResult, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";
import { applyExaFetchFallbacks } from "./fallback.js";

export class ExaProvider implements SearchProvider, FetchProvider {
  private key: string;
  constructor(private config: WebKitConfig) { this.key = requireKey(config, "exa"); }

  private headers() {
    return { "content-type": "application/json", "x-api-key": this.key };
  }

  async search(input: SearchInput, signal?: AbortSignal) {
    const textCharacters = input.contextTokens ? Math.min(100_000, Math.max(1, Math.floor(input.contextTokens * 4 / (input.numResults ?? DEFAULT_NUM_RESULTS)))) : undefined;
    const body = {
      query: input.query,
      numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
      contents: input.contents ?? {
        highlights: input.purpose ? { query: input.purpose } : true,
        ...(textCharacters ? { text: { maxCharacters: textCharacters } } : {}),
        ...(typeof input.maxAgeHours === "number" ? { maxAgeHours: input.maxAgeHours } : {}),
      },
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
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
      timeoutMs: 30000,
    });
    return {
      provider: "exa" as const,
      query: input.query,
      results: (data.results ?? []).map((r: any, i: number) => {
        const content = asText(r.text ?? r.highlights ?? r.summary);
        return {
          title: r.title,
          url: r.url,
          snippet: asSnippet(content),
          content,
          contentFormat: content ? "markdown" as const : undefined,
          siteName: r.author ?? r.publishedDate,
          position: i + 1,
        };
      }).filter((r: any) => r.url),
    };
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<WebFetchResult> {
    const urls = normalizeUrls(input);
    if (urls.length === 0) return { provider: "exa", results: [] };
    const data = await requestJson<any>("https://api.exa.ai/contents", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        urls,
        text: { maxCharacters: 100_000 },
        highlights: false,
        maxAgeHours: input.refresh === true
          ? 0
          : input.maxAgeHours ?? (typeof input.maxAgeMs === "number" ? Math.floor(input.maxAgeMs / 3_600_000) : undefined),
      }),
      signal,
      timeoutMs: 45000,
    });
    const list = data.results ?? [];
    const primary: WebFetchResult = { provider: "exa", results: urls.map((url, i) => {
      const r: any = list.find((item: any) => urlsMatch(item.url, url)) ?? list[i];
      if (!r) return { url, error: "No content returned by Exa contents endpoint." };
      return { url: r.url ?? url, title: r.title, content: r.text ?? r.summary ?? "", format: "markdown" as const, metadata: withoutContent(r) };
    }) };
    return applyExaFetchFallbacks(this.config, input, urls, primary, signal);
  }

  async searchCode(input: ExaCodeInput, signal?: AbortSignal): Promise<ExaCodeResult> {
    const data = await requestJson<any>("https://api.exa.ai/context", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        query: input.query,
        tokensNum: input.tokensNum ?? "dynamic",
      }),
      signal,
      timeoutMs: 45_000,
    });
    return {
      provider: "exa",
      query: data.query ?? input.query,
      response: data.response ?? "",
      resultsCount: data.resultsCount,
      searchTime: data.searchTime,
      outputTokens: data.outputTokens,
      requestId: data.requestId,
    };
  }
}
