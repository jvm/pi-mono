import { FETCH_CONCURRENCY } from "../limits.js";
import { requestText, mapConcurrent, normalizeUrls } from "../http.js";
import type { FetchInput, FetchProvider, WebKitConfig } from "../types.js";

export class MarkdownNewProvider implements FetchProvider {
  constructor(private config: WebKitConfig) {}

  async fetch(input: FetchInput, signal?: AbortSignal) {
    const urls = normalizeUrls(input);
    const results = await mapConcurrent(urls, FETCH_CONCURRENCY, async (url) => {
      try {
        const { text, headers } = await requestText("https://markdown.new/", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/markdown, text/plain, */*" },
          body: JSON.stringify({
            url,
            method: input.method ?? this.config.markdownNew.method,
            retain_images: input.retainImages ?? this.config.markdownNew.retainImages,
          }),
          signal,
          timeoutMs: 45_000,
        });
        return {
          url,
          requestedUrl: url,
          content: text,
          format: "markdown" as const,
          metadata: {
            estimatedTokens: numberHeader(headers.get("x-markdown-tokens")),
            conversionMethod: headers.get("x-markdown-method") ?? undefined,
          },
        };
      } catch (e) {
        return { url, requestedUrl: url, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { provider: "markdown_new" as const, results };
  }
}

function numberHeader(value: string | null): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
