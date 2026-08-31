import { asSnippet, asText, requestJson } from "../http.js";
import type { SearchInput, SearchProvider, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";

export class BraveProvider implements SearchProvider {
  private key: string;
  constructor(config: WebKitConfig) { this.key = requireKey(config, "brave"); }

  async search(input: SearchInput, signal?: AbortSignal) {
    const params: Record<string, string | number | boolean | string[]> = { q: boundedQuery(input.query) };
    if (input.numResults) {
      params.count = input.numResults;
      params.maximum_number_of_urls = input.numResults;
    }
    if (input.contextTokens) params.maximum_number_of_tokens = Math.max(1_024, Math.min(input.contextTokens, 32_768));
    if (typeof input.country === "string") params.country = input.country;
    if (typeof input.searchLang === "string") params.search_lang = input.searchLang;
    if (typeof input.safesearch === "string") params.safesearch = input.safesearch;
    if (typeof input.freshness === "string") params.freshness = input.freshness;
    if (typeof input.spellcheck === "boolean") params.spellcheck = input.spellcheck;
    if (typeof input.contextThresholdMode === "string") params.context_threshold_mode = input.contextThresholdMode;
    if (typeof input.maxSnippets === "number") params.maximum_number_of_snippets = input.maxSnippets;
    if (typeof input.maxTokensPerUrl === "number") params.maximum_number_of_tokens_per_url = input.maxTokensPerUrl;
    if (typeof input.maxSnippetsPerUrl === "number") params.maximum_number_of_snippets_per_url = input.maxSnippetsPerUrl;
    if (typeof input.goggles === "string" || Array.isArray(input.goggles)) params.goggles = input.goggles;

    const url = new URL("https://api.search.brave.com/res/v1/llm/context");
    for (const [name, value] of Object.entries(params)) {
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, item);
      else url.searchParams.set(name, String(value));
    }
    const usePost = input.goggles != null || url.toString().length > 2_000;
    const data = await requestJson<any>(usePost ? `${url.origin}${url.pathname}` : url.toString(), {
      method: usePost ? "POST" : undefined,
      headers: { "X-Subscription-Token": this.key, accept: "application/json", ...(usePost ? { "content-type": "application/json" } : {}) },
      body: usePost ? JSON.stringify(params) : undefined,
      signal,
      timeoutMs: 30000,
    });
    const sources = data.sources ?? data.web?.results ?? [];
    const snippets = data.grounding?.generic ?? [];
    const sourceRows = Array.isArray(sources)
      ? sources
      : Object.entries(sources).map(([url, source]: [string, any]) => ({ ...source, url }));
    const rows = snippets.length ? snippets : sourceRows;
    return { provider: "brave" as const, query: input.query, results: rows.map((r: any, i: number) => {
      const content = asText(r.snippets ?? r.snippet ?? r.description ?? snippets[i]?.snippets);
      return {
        title: r.title ?? r.name, url: r.url, snippet: asSnippet(content), content, contentFormat: content ? "markdown" as const : undefined, siteName: r.site_name ?? r.source, position: i + 1,
      };
    }).filter((r: any) => r.url) };
  }
}

function boundedQuery(query: string): string {
  return query.trim().split(/\s+/).slice(0, 50).join(" ").slice(0, 400);
}
