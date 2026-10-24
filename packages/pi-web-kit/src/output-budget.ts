import { boundCodeResult } from "./code-output.js";
import { MAX_FETCH_LINK_OUTPUT_BYTES, MAX_OUTPUT_BYTES, safePrefix } from "./limits.js";
import type { ExaCodeResult } from "./types.js";

const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= MAX_OUTPUT_BYTES;
const retry = (message: string) => ({ truncated: true as const, message });
type SearchOutput = { provider?: string; queries: Array<Record<string, any> & { results: any[] }> };
type FetchOutput = { provider?: string; results: any[] };

/** Bound evidence, never identity fields. Omit complete records if metadata cannot fit. */
export function boundStructuredResult(result: any): unknown {
  if (result?.searchType === "auto" && Array.isArray(result.results)) return boundCodeResult(result as ExaCodeResult);
  if (Array.isArray(result?.results) && result.results.some((item: any) => typeof item?.content === "string" && item.range)) {
    return boundFetchResult(result);
  }
  if (fits(result)) return result;
  if (Array.isArray(result?.queries) && result.queries.every((group: any) => Array.isArray(group?.results))) {
    return boundSearchResult(result);
  }
  if (result?.provider === "context7") {
    if (Array.isArray(result.codeSnippets) && Array.isArray(result.infoSnippets)) return boundDocumentation(result);
    if (Array.isArray(result.results)) return boundLibraries(result);
  }
  return retry("Structured result exceeded 50KB; refine the request or use smaller limits.");
}

function boundSearchResult(value: SearchOutput) {
  const candidate = (characters: number, count?: number) => ({
    ...value,
    queries: value.queries.map(group => {
      const original = group.results.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
      const results = group.results.slice(0, count).map(item => {
        const bounded = { ...item };
        for (const field of ["snippet", "content"]) {
          if (typeof bounded[field] === "string") bounded[field] = safePrefix(bounded[field], characters);
        }
        return bounded;
      });
      const contextCharacters = results.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
      return { ...group, results, resultCount: results.length, contextCharacters,
        omittedContextCharacters: (group.omittedContextCharacters ?? 0) + original - contextCharacters,
        omittedResultCount: (group.omittedResultCount ?? 0) + group.results.length - results.length };
    }),
  });
  const maxCharacters = Math.max(0, ...value.queries.flatMap(group =>
    group.results.flatMap(item => [item.snippet?.length ?? 0, item.content?.length ?? 0])));
  const maxCount = Math.max(0, ...value.queries.map(group => group.results.length));
  for (let count = maxCount; count >= 0; count--) {
    if (!fits(candidate(0, count))) continue;
    return maximize(maxCharacters, characters => candidate(characters, count));
  }
  return retry("Search metadata exceeded 50KB; retry with fewer queries or results.");
}

function boundFetchResult(value: FetchOutput) {
  // Share one link budget across all nonempty arrays. Keep each URL intact and
  // account for omissions, including links rejected before this output stage.
  const fields = ["links", "imageLinks"] as const;
  const lists = value.results.reduce((sum, page) => sum + fields.filter(field => page[field]?.length).length, 0);
  const linkBytes = Math.floor(MAX_FETCH_LINK_OUTPUT_BYTES / Math.max(1, lists));
  let compact = { ...value, results: value.results.map(page => {
    const bounded = { ...page };
    for (const field of fields) {
      if (!Array.isArray(page[field])) continue;
      const selected: string[] = [];
      let bytes = 2;
      for (const link of page[field]) {
        const size = Buffer.byteLength(JSON.stringify(link)) + (selected.length ? 1 : 0);
        if (bytes + size > linkBytes) continue;
        selected.push(link);
        bytes += size;
      }
      const omittedField = field === "links" ? "omittedLinkCount" : "omittedImageLinkCount";
      bounded[field] = selected;
      bounded[omittedField] = (page[omittedField] ?? 0) + page[field].length - selected.length;
    }
    return bounded;
  }) };
  if (fits(compact)) return compact;
  // Titles are display labels, unlike requested/final URLs and continuation
  // targets. Shorten only those labels before reducing the page evidence.
  compact = { ...compact, results: compact.results.map(page => ({
    ...page, ...(typeof page.title === "string" ? { title: safePrefix(page.title, 1_000) } : {}),
  })) };
  const candidate = (characters: number) => ({
    ...compact,
    results: compact.results.map(page => {
      if (typeof page.content !== "string" || !page.range) return page;
      const content = safePrefix(page.content, characters);
      const hasNext = page.range.offset + content.length < page.range.total;
      return { ...page, content, range: { ...page.range, returned: content.length,
        truncated: page.range.offset > 0 || hasNext, hasNext,
        nextOffset: hasNext ? page.range.offset + content.length : undefined } };
    }),
  });
  if (!fits(candidate(0))) return retry("Fetch metadata exceeded 50KB; retry with fewer URLs.");
  const best = maximize(Math.max(0, ...compact.results.map(page => page.content?.length ?? 0)), candidate);
  if (best.results.some(page => page.content === "" && page.range?.hasNext)) {
    return retry("Fetch metadata left no room for content; retry with fewer URLs.");
  }
  return best;
}

function maximize<T>(high: number, candidate: (characters: number) => T): T {
  let low = 0;
  let best = candidate(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = candidate(middle);
    if (fits(current)) { best = current; low = middle + 1; }
    else high = middle - 1;
  }
  return best;
}

function boundDocumentation(value: any) {
  const result = { ...value, codeSnippets: [] as any[], infoSnippets: [] as any[],
    omittedCodeSnippetCount: (value.omittedCodeSnippetCount ?? 0) + value.codeSnippets.length,
    omittedInfoSnippetCount: (value.omittedInfoSnippetCount ?? 0) + value.infoSnippets.length,
    message: "Some documentation snippets were omitted to fit 50KB. Refine the query or request fewer snippets for complete examples." };
  if (!fits(result)) return retry("Documentation metadata exceeded 50KB; refine the query.");
  for (const [field, omitted] of [["codeSnippets", "omittedCodeSnippetCount"], ["infoSnippets", "omittedInfoSnippetCount"]] as const) {
    for (const snippet of value[field]) {
      result[field].push(snippet);
      result[omitted]--;
      if (!fits(result)) { result[field].pop(); result[omitted]++; }
    }
  }
  return result;
}

function boundLibraries(value: any) {
  const result = { ...value, results: [] as any[], omittedResultCount: (value.omittedResultCount ?? 0) + value.results.length };
  if (!fits(result)) return retry("Library metadata exceeded 50KB; refine the request.");
  for (const library of value.results) {
    result.results.push(library);
    result.omittedResultCount--;
    if (!fits(result)) { result.results.pop(); result.omittedResultCount++; }
  }
  return result;
}
