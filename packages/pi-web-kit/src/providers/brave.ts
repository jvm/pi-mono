import { asSnippet, requestJson } from "../http.js";
import type { SearchInput, SearchProvider, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";

export class BraveProvider implements SearchProvider {
  private key: string;
  constructor(config: WebKitConfig) { this.key = requireKey(config, "brave"); }

  async search(input: SearchInput, signal?: AbortSignal) {
    const url = new URL("https://api.search.brave.com/res/v1/llm/context");
    url.searchParams.set("q", input.query);
    if (input.numResults) {
      const count = String(Math.max(1, Math.min(input.numResults, 20)));
      url.searchParams.set("count", count);
      url.searchParams.set("maximum_number_of_urls", String(input.maxUrls ?? count));
    }
    if (typeof input.country === "string") url.searchParams.set("country", input.country);
    if (typeof input.searchLang === "string") url.searchParams.set("search_lang", input.searchLang);
    if (typeof input.uiLang === "string") url.searchParams.set("ui_lang", input.uiLang);
    if (typeof input.safesearch === "string") url.searchParams.set("safesearch", input.safesearch);
    if (typeof input.freshness === "string") url.searchParams.set("freshness", input.freshness);
    const data = await requestJson<any>(url.toString(), { headers: { "X-Subscription-Token": this.key, accept: "application/json" }, signal, timeoutMs: 30000 });
    const sources = data.sources ?? data.web?.results ?? [];
    const snippets = data.grounding?.generic ?? [];
    const rows = sources.length ? sources : snippets;
    return { provider: "brave" as const, query: input.query, results: rows.map((r: any, i: number) => ({
      title: r.title ?? r.name, url: r.url, snippet: asSnippet(r.snippets ?? r.description ?? snippets[i]?.snippets), siteName: r.site_name ?? r.source, position: i + 1,
    })).filter((r: any) => r.url) };
  }
}
