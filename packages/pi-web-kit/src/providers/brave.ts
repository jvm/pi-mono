import { asSnippet, asText, requestJson } from "../http.js";
import type { SearchInput, SearchProvider, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";

export class BraveProvider implements SearchProvider {
  private key: string;
  constructor(config: WebKitConfig) { this.key = requireKey(config, "brave"); }

  async search(input: SearchInput, signal?: AbortSignal) {
    const url = new URL("https://api.search.brave.com/res/v1/llm/context");
    url.searchParams.set("q", boundedQuery(input.query));
    if (input.numResults) {
      const count = String(input.numResults);
      url.searchParams.set("count", count);
      url.searchParams.set("maximum_number_of_urls", count);
    }
    if (input.contextTokens) url.searchParams.set("maximum_number_of_tokens", String(Math.max(1_024, Math.min(input.contextTokens, 32_768))));
    if (typeof input.country === "string") url.searchParams.set("country", input.country);
    if (typeof input.searchLang === "string") url.searchParams.set("search_lang", input.searchLang);
    if (typeof input.safesearch === "string") url.searchParams.set("safesearch", input.safesearch);
    if (typeof input.freshness === "string") url.searchParams.set("freshness", input.freshness);
    if (typeof input.spellcheck === "boolean") url.searchParams.set("spellcheck", String(input.spellcheck));
    if (typeof input.contextThresholdMode === "string") url.searchParams.set("context_threshold_mode", input.contextThresholdMode);
    if (typeof input.maxSnippets === "number") url.searchParams.set("maximum_number_of_snippets", String(input.maxSnippets));
    if (typeof input.maxTokensPerUrl === "number") url.searchParams.set("maximum_number_of_tokens_per_url", String(input.maxTokensPerUrl));
    if (typeof input.maxSnippetsPerUrl === "number") url.searchParams.set("maximum_number_of_snippets_per_url", String(input.maxSnippetsPerUrl));
    if (typeof input.goggles === "string") url.searchParams.set("goggles", input.goggles);
    if (Array.isArray(input.goggles)) for (const goggle of input.goggles) if (typeof goggle === "string") url.searchParams.append("goggles", goggle);
    const usePost = input.goggles != null || url.toString().length > 2_000;
    const params: Record<string, unknown> = Object.fromEntries(url.searchParams);
    if (Array.isArray(input.goggles)) params.goggles = input.goggles;
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
