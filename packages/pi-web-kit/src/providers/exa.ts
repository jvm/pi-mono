import { asSnippet, asText, normalizeUrls, requestJson } from "../http.js";
import type { ExaCodeInput, ExaCodeResult, ExaDiagnostic, ExaDiagnosticSink, FetchInput, FetchProvider, SearchInput, SearchProvider, WebFetchResult, WebKitConfig, WebSearchResult } from "../types.js";
import { requireKey } from "../config.js";
import { codeSearchOptions, codeSearchResult } from "../code-output.js";
import { CODE_SEARCH_CRAWL_TIMEOUT_MS, CODE_SEARCH_TIMEOUT_MS } from "../limits.js";
import { buildExaSearchBody, exaDiagnostic, exaFetchMaxAgeHours, exaNotices } from "./exa-contract.js";
import { mapExaContents } from "./exa-contents.js";
import { applyExaFetchFallbacks } from "./fallback.js";

export class ExaProvider implements SearchProvider, FetchProvider {
  private key: string;
  constructor(private config: WebKitConfig, private onDiagnostic?: ExaDiagnosticSink) { this.key = requireKey(config, "exa"); }

  private headers() {
    return { "content-type": "application/json", "x-api-key": this.key };
  }

  async search(input: SearchInput, signal?: AbortSignal) {
    const body = buildExaSearchBody(input);
    return this.searchBody(body, signal);
  }

  private async searchBody(body: ReturnType<typeof buildExaSearchBody>, signal?: AbortSignal,
    codeOnly = false): Promise<WebSearchResult> {
    const data = await this.request("/search", body, codeOnly ? CODE_SEARCH_TIMEOUT_MS : 30_000, signal);
    const results = data.results.map((r: any, i: number) => {
      // Never turn a metadata-only/live-crawl failure into stale text evidence.
      const highlights = Array.isArray(r?.highlights)
        ? asText(r.highlights.filter((h: unknown) => typeof h === "string" && h.trim())) : undefined;
      const content = codeOnly ? highlights : highlights ?? asText(r?.text) ?? asText(r?.summary);
      return {
        title: r?.title, url: r?.url, snippet: asSnippet(content), content,
        contentFormat: content ? "markdown" as const : undefined,
        siteName: r?.author ?? r?.publishedDate, publishedDate: r?.publishedDate, position: i + 1,
      };
    }).filter((r: any) => typeof r.url === "string" && r.url && (!codeOnly || r.content));
    return {
      provider: "exa" as const,
      query: body.query,
      ...exaNotices(data, Object.values(this.config.apiKeys)),
      ...(codeOnly ? { omittedNoContentCount: data.results.length - results.length } : {}),
      results,
    };
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<WebFetchResult> {
    const maxAgeHours = exaFetchMaxAgeHours(input);
    const urls = normalizeUrls(input);
    if (urls.length === 0) return { provider: "exa", results: [] };
    const data = await requestJson<any>("https://api.exa.ai/contents", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        urls,
        text: { maxCharacters: 100_000 },
        highlights: false,
        maxAgeHours,
      }),
      signal,
      timeoutMs: 45000,
    });
    const primary = mapExaContents(urls, data);
    return applyExaFetchFallbacks(this.config, input, urls, primary, signal);
  }

  async searchCode(input: ExaCodeInput, signal?: AbortSignal): Promise<ExaCodeResult> {
    const options = codeSearchOptions(input);
    const body = buildExaSearchBody({ ...options, type: "auto", maxAgeHours: 0 });
    Object.assign(body.contents, { livecrawlTimeout: CODE_SEARCH_CRAWL_TIMEOUT_MS });
    return codeSearchResult(options, await this.searchBody(body, signal, true), input.contextTokens);
  }

  private async request(endpoint: ExaDiagnostic["endpoint"], body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    const started = performance.now();
    // Unknown search types may be legitimate, but caller-controlled values do
    // not belong in logs. Only known mode identifiers are recorded.
    const searchType = ["auto", "lite", "deep", "deep-lite", "fast", "instant", "deep-reasoning", "neural"].includes(String(body.type)) ? String(body.type) : undefined;
    const base = (): ExaDiagnostic => ({ endpoint, durationMs: Math.round(performance.now() - started),
      ...(searchType ? { searchType } : {}) });
    const emit = (diagnostic: ExaDiagnostic) => {
      try { this.onDiagnostic?.(diagnostic); } catch { /* Diagnostics must not fail a search. */ }
    };
    try {
      signal?.throwIfAborted();
      const data = await requestJson<any>(`https://api.exa.ai${endpoint}`, {
        method: "POST", headers: this.headers(), body: JSON.stringify(body), signal, timeoutMs,
        redirect: "error",
      });
      if (!data || !Array.isArray(data.results)) throw new Error("Provider returned invalid JSON.");
      signal?.throwIfAborted();
      emit(exaDiagnostic(data, base(), Object.values(this.config.apiKeys)));
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = /^Provider request failed \(HTTP (\d{3})\)\.$/.exec(message);
      emit({ ...base(), error: signal?.aborted ? "cancelled" : status ? "http"
        : /^Request timed out/.test(message) ? "timeout" : message === "Provider returned invalid JSON." ? "invalid-response" : "network",
        ...(status ? { httpStatus: Number(status[1]) } : {}) });
      throw error;
    }
  }
}
