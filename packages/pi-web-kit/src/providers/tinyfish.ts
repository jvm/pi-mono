import { asSnippet, normalizeUrls, requestJson, withoutContent } from "../http.js";
import { DEFAULT_NUM_RESULTS, MAX_URL_COUNT, TINYFISH_MAX_PAGE } from "../limits.js";
import type { FetchInput, FetchProvider, SearchInput, SearchProvider, WebKitConfig, WebSearchResult } from "../types.js";
import { urlsMatch } from "../urls.js";
import { requireKey } from "../config.js";

export class TinyFishProvider implements SearchProvider, FetchProvider {
  private key: string;
  constructor(config: WebKitConfig) { this.key = requireKey(config, "tinyfish"); }

  async search(input: SearchInput, signal?: AbortSignal) {
    const desired = input.numResults ?? DEFAULT_NUM_RESULTS;
    const firstPage = typeof input.page === "number" ? Math.max(0, Math.min(input.page, TINYFISH_MAX_PAGE)) : 0;
    const research = input.domainType === "research_paper";
    const dates = orderedStrings(input.afterDate, input.beforeDate);
    const years = orderedNumbers(input.pubYearMin, input.pubYearMax);
    const results: WebSearchResult["results"] = [];
    const seen = new Set<string>();
    let lastPage = firstPage - 1;

    for (let page = firstPage; page <= TINYFISH_MAX_PAGE && results.length < desired; page++) {
      lastPage = page;
      const url = new URL("https://api.search.tinyfish.ai/");
      url.searchParams.set("query", input.query);
      url.searchParams.set("page", String(page));
      setString(url, "purpose", input.purpose);
      setString(url, "location", input.location);
      setString(url, "language", input.language);
      setDomains(url, "include_domains", input.includeDomains);
      setDomains(url, "exclude_domains", input.excludeDomains);
      setString(url, "domain_type", input.domainType);
      if (research) {
        setNumber(url, "pub_year_min", years[0]);
        setNumber(url, "pub_year_max", years[1]);
      } else if (typeof input.recencyMinutes === "number") {
        setNumber(url, "recency_minutes", input.recencyMinutes);
      } else {
        setString(url, "after_date", dates[0]);
        setString(url, "before_date", dates[1]);
      }
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

    if (input.contextTokens && results.length) {
      const contextCharacters = input.contextTokens * 4;
      let extractedCharacters = 0;
      for (let i = 0; i < results.length && extractedCharacters < contextCharacters;) {
        // ponytail: budget for about 512 useful tokens per page; fetch another batch when pages are short.
        const batchSize = Math.min(MAX_URL_COUNT, Math.max(1, Math.ceil((contextCharacters - extractedCharacters) / 2_048)));
        const batch = results.slice(i, i + batchSize);
        const fetched = await this.fetch({ urls: batch.map((item) => item.url), format: "markdown", purpose: input.purpose }, signal);
        for (const item of batch) {
          const page = fetched.results.find((candidate) => candidate.url === item.url || candidate.metadata?.requestedUrl === item.url);
          if (page?.content) {
            item.content = page.content;
            item.contentFormat = "markdown";
            extractedCharacters += page.content.length;
          }
        }
        i += batch.length;
      }
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
      body: JSON.stringify({
        urls,
        purpose: input.purpose,
        format: input.format ?? "markdown",
        links: input.links,
        image_links: input.imageLinks,
        ttl: input.refresh === true
          ? 0
          : input.ttl ?? (typeof input.maxAgeMs === "number" ? Math.floor(input.maxAgeMs / 1_000) : undefined),
        per_url_timeout_ms: input.perUrlTimeoutMs,
        include_selectors: input.includeSelectors,
        exclude_selectors: input.excludeSelectors,
      }),
      signal,
      timeoutMs: 150000,
    });
    const list = data.results ?? data.data ?? data.pages ?? [];
    const errors = data.errors ?? [];
    return { provider: "tinyfish" as const, results: urls.map((url) => {
      const r = list.find((x: any) => urlsMatch(x.url ?? x.source_url, url));
      const failure = errors.find((x: any) => urlsMatch(x.url, url));
      if (!r) return { url, error: failure ? `${failure.error}${failure.status ? ` (${failure.status})` : ""}` : "No content returned by TinyFish." };
      const content = r.text ?? r.content ?? r.markdown ?? r.html;
      return {
        url: r.final_url ?? r.url ?? url,
        content: stringifyContent(content),
        format: input.format ?? r.format ?? "markdown",
        title: r.title,
        metadata: { ...withoutContent(r), requestedUrl: url, finalUrl: r.final_url },
        error: r.error,
      };
    }) };
  }
}

function setString(url: URL, name: string, value: unknown) {
  if (typeof value === "string" && value) url.searchParams.set(name, value);
}

function setNumber(url: URL, name: string, value: unknown) {
  if (typeof value === "number") url.searchParams.set(name, String(value));
}

function setDomains(url: URL, name: string, value: unknown) {
  if (Array.isArray(value) && value.length) url.searchParams.set(name, value.join(","));
  else setString(url, name, value);
}

function orderedStrings(a: unknown, b: unknown): [string | undefined, string | undefined] {
  const values = [a, b].filter((value): value is string => typeof value === "string").sort();
  return [values[0], values[1]];
}

function orderedNumbers(a: unknown, b: unknown): [number | undefined, number | undefined] {
  const values = [a, b].filter((value): value is number => typeof value === "number").sort((x, y) => x - y);
  return [values[0], values[1]];
}

function stringifyContent(value: unknown): string | undefined {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
