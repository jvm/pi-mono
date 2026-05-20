import { FETCH_CONCURRENCY } from "../limits.js";
import { fetchWithTimeout, mapConcurrent, normalizeUrls } from "../http.js";
import type { FetchInput, FetchProvider, WebKitConfig } from "../types.js";

export class MarkdownNewProvider implements FetchProvider {
  constructor(private config: WebKitConfig) {}

  async fetch(input: FetchInput, signal?: AbortSignal) {
    const urls = normalizeUrls(input);
    const results = await mapConcurrent(urls, FETCH_CONCURRENCY, async (url) => {
      try {
        const res = await fetchWithTimeout("https://markdown.new/", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/markdown, text/plain, */*" },
          body: JSON.stringify({
            url,
            method: input.method ?? this.config.markdownNew.method,
            retainImages: input.retainImages ?? this.config.markdownNew.retainImages,
          }),
          signal,
          timeoutMs: 45_000,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 1000)}`);
        return { url, content: text, format: "markdown" as const };
      } catch (e) {
        return { url, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { provider: "markdown_new" as const, results };
  }
}
