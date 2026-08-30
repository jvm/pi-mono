import { asSnippet, normalizeUrls, requestJson } from "../http.js";
import { DEFAULT_NUM_RESULTS, MAX_URL_COUNT, TINYFISH_MAX_PAGE } from "../limits.js";
import type { FetchInput, FetchProvider, SearchInput, SearchProvider, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";

export class TinyFishProvider implements SearchProvider, FetchProvider {
  private key: string;
  constructor(config: WebKitConfig) { this.key = requireKey(config, "tinyfish"); }

  async search(input: SearchInput, signal?: AbortSignal) {
    const desired = input.numResults ?? DEFAULT_NUM_RESULTS;
    const firstPage = typeof input.page === "number" ? Math.max(0, Math.min(input.page, TINYFISH_MAX_PAGE)) : 0;
    const results = [];
    const seen = new Set<string>();
    let lastPage = firstPage - 1;

    for (let page = firstPage; page <= TINYFISH_MAX_PAGE && results.length < desired; page++) {
      lastPage = page;
      const url = new URL("https://api.search.tinyfish.ai/");
      url.searchParams.set("query", input.query);
      url.searchParams.set("page", String(page));
      const data = await requestJson<any>(url.toString(), { headers: { "X-API-Key": this.key }, signal, timeoutMs: 10000 });
      const list = data.results ?? data.data ?? data.web ?? [];
      if (!Array.isArray(list) || list.length === 0) break;
      for (const r of list) {
        const resultUrl = r.url ?? r.link;
        if (!resultUrl || seen.has(resultUrl)) continue;
        seen.add(resultUrl);
        results.push({
          title: r.title,
          url: resultUrl,
          snippet: asSnippet(r.snippet ?? r.description ?? r.text),
          siteName: r.siteName ?? r.source,
          position: results.length + 1,
        });
        if (results.length === desired) break;
      }
      if (typeof data.total_results === "number" && results.length >= data.total_results) break;
    }

    return {
      provider: "tinyfish" as const,
      query: input.query,
      effectiveResultLimit: lastPage === TINYFISH_MAX_PAGE && results.length < desired ? results.length : desired,
      results,
    };
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
      return { url, content: stringifyContent(content), format: input.format ?? r.format ?? "markdown", title: r.title, metadata: r, error: r.error };
    }) };
  }
}

function stringifyContent(value: unknown): string | undefined {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
