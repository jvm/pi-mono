import { asSnippet, normalizeUrls, requestJson } from "../http.js";
import { MAX_URL_COUNT } from "../limits.js";
import type { FetchInput, FetchProvider, SearchInput, SearchProvider, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";

export class TinyFishProvider implements SearchProvider, FetchProvider {
  private key: string;
  constructor(config: WebKitConfig) { this.key = requireKey(config, "tinyfish"); }

  async search(input: SearchInput, signal?: AbortSignal) {
    const url = new URL("https://api.search.tinyfish.ai/");
    url.searchParams.set("query", input.query);
    if (input.numResults) url.searchParams.set("limit", String(input.numResults));
    if (typeof input.page === "number") url.searchParams.set("page", String(Math.min(input.page, 10)));
    const data = await requestJson<any>(url.toString(), { headers: { "X-API-Key": this.key }, signal, timeoutMs: 10000 });
    const list = data.results ?? data.data ?? data.web ?? [];
    return { provider: "tinyfish" as const, query: input.query, results: list.map((r: any, i: number) => ({
      title: r.title, url: r.url ?? r.link, snippet: asSnippet(r.snippet ?? r.description ?? r.text), siteName: r.siteName ?? r.source, position: r.position ?? i + 1,
    })).filter((r: any) => r.url) };
  }

  async fetch(input: FetchInput, signal?: AbortSignal) {
    const urls = normalizeUrls(input);
    if (urls.length > MAX_URL_COUNT) throw new Error(`TinyFish fetch supports a maximum of ${MAX_URL_COUNT} URLs per request.`);
    const data = await requestJson<any>("https://api.fetch.tinyfish.ai", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": this.key },
      body: JSON.stringify({ urls, format: input.format ?? "markdown", links: input.links, image_links: input.imageLinks }),
      signal,
      timeoutMs: 150000,
    });
    const list = data.results ?? data.data ?? data.pages ?? [];
    return { provider: "tinyfish" as const, results: urls.map((url, i) => {
      const r = list.find((x: any) => (x.url ?? x.source_url) === url) ?? list[i];
      if (!r) return { url, error: "No content returned by TinyFish." };
      const content = r.text ?? r.content ?? r.markdown ?? r.html;
      return { url, content: typeof content === "string" ? content : JSON.stringify(content, null, 2), format: input.format ?? r.format ?? "markdown", title: r.title, metadata: r, error: r.error };
    }) };
  }
}
