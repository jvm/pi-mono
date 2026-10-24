import { withoutContent } from "../http.js";
import type { WebFetchResult } from "../types.js";
import { urlsMatch } from "../urls.js";

/** Reserve identities before considering legacy, identity-less redirect results. */
export function mapExaContents(urls: string[], data: any): WebFetchResult {
  if (data?.results != null && !Array.isArray(data.results)) throw new Error("Provider returned invalid JSON.");
  const results: any[] = (data?.results ?? []).filter((r: any) => r && typeof r === "object");
  const statuses: any[] = Array.isArray(data?.statuses) ? data.statuses : [];
  const failed = new Set(urls.filter(url => statuses.some(s => s?.status === "error" && urlsMatch(s.id, url))));
  const remaining = results.filter(r => !urls.some(url => failed.has(url) && urlsMatch(r.id ?? r.url, url)));
  const matched = new Map<string, any>();
  const assign = (url: string, index: number) => {
    if (index >= 0) matched.set(url, remaining.splice(index, 1)[0]);
  };
  for (const url of urls) {
    if (!failed.has(url)) assign(url, remaining.findIndex(r => urlsMatch(r.id, url)));
  }
  for (const url of urls) {
    if (failed.has(url) || matched.has(url)) continue;
    assign(url, remaining.findIndex(r => urlsMatch(r.url, url)
      && !urls.some(other => other !== url && urlsMatch(r.id, other))));
  }
  const unresolved = urls.filter(url => !failed.has(url) && !matched.has(url));
  // Older responses may omit statuses and use canonical URLs as their IDs.
  // Only retain positional compatibility for a complete batch, or when there
  // is exactly one possible pairing. Never guess across a partial batch.
  if ((!statuses.length && results.length === urls.length)
    || (unresolved.length === 1 && remaining.length === 1)) {
    for (const url of unresolved) {
      assign(url, remaining.findIndex(r => !urls.some(requested => urlsMatch(r.id ?? r.url, requested))));
    }
  }
  return { provider: "exa", results: urls.map(url => {
    const r = matched.get(url);
    if (!r) return { url, requestedUrl: url, error: "No content returned by Exa contents endpoint." };
    return { url: r.url ?? url, requestedUrl: url, title: r.title, content: r.text ?? r.summary ?? "",
      format: "markdown", metadata: withoutContent(r) };
  }) };
}
