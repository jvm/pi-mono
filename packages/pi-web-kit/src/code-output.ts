import { applySearchContextBudget, DEFAULT_CODE_RESULTS, MAX_CODE_CONTEXT_TOKENS, MAX_CODE_RESULTS, MAX_OUTPUT_BYTES, safePrefix } from "./limits.js";
import type { ExaCodeInput, ExaCodeResult, WebSearchResult } from "./types.js";

/** Code search has no mode, cache, synthesis, beta, or legacy API overrides. */
export function codeSearchOptions(input: ExaCodeInput) {
  const allowed = new Set(["query", "purpose", "numResults", "contextTokens", "includeDomains", "excludeDomains"]);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new Error("Unsupported code_search parameter. Code search always uses Auto with live content; use query, purpose, numResults, contextTokens, or domain filters.");
  }
  for (const [name, maximum] of [["numResults", MAX_CODE_RESULTS], ["contextTokens", MAX_CODE_CONTEXT_TOKENS]] as const) {
    const value = input[name];
    if (value != null && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
      throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
    }
  }
  return { ...input, numResults: input.numResults ?? DEFAULT_CODE_RESULTS,
    contextTokens: input.contextTokens ?? MAX_CODE_CONTEXT_TOKENS };
}

export function codeSearchResult(input: ReturnType<typeof codeSearchOptions>, result: WebSearchResult, requestedContextTokens?: number): ExaCodeResult {
  // One evidence field per source: duplicate snippets must not evade a small
  // context budget. Count evidence discarded by a provider over-return as well.
  const selected = result.results.slice(0, input.numResults).map(({ snippet: _snippet, ...source }) => source);
  const omittedByResultLimit = result.results.slice(input.numResults).reduce((sum, r) => sum + (r.content?.length ?? 0), 0);
  const bounded = applySearchContextBudget(selected, input.contextTokens * 4);
  return {
    provider: "exa", query: input.query, searchType: "auto", maxAgeHours: 0,
    requestedResultLimit: input.numResults, effectiveResultLimit: input.numResults,
    requestedContextTokens, effectiveContextTokens: input.contextTokens,
    contextCharacters: bounded.contextCharacters, omittedContextCharacters: bounded.omittedContextCharacters + omittedByResultLimit,
    resultCount: bounded.results.length,
    omittedResultCount: Math.max(0, result.results.length - bounded.results.length),
    omittedNoContentCount: result.omittedNoContentCount ?? 0,
    results: bounded.results, notices: result.notices, omittedNoticeCount: result.omittedNoticeCount,
  };
}

/** Preserve complete source URLs and useful excerpts within the serialized byte budget. */
export function boundCodeResult(value: ExaCodeResult): ExaCodeResult | { truncated: true; message: string } {
  const originalCharacters = value.results.reduce((sum, r) => sum + (r.content?.length ?? 0), 0);
  const sources = value.results.map(r => ({ ...r,
    ...(r.title ? { title: safePrefix(r.title, 1_000) } : {}),
    ...(r.siteName ? { siteName: safePrefix(r.siteName, 1_000) } : {}),
    ...(r.snippet ? { snippet: safePrefix(r.snippet, 1_000) } : {}),
  }));
  const candidate = (characters: number, count = sources.length): ExaCodeResult => {
    const results = sources.slice(0, count).map(r => ({ ...r,
      ...(r.content != null ? { content: safePrefix(r.content, characters) } : {}),
      ...(r.snippet != null ? { snippet: safePrefix(r.snippet, characters) } : {}),
    }));
    const contextCharacters = results.reduce((sum, r) => sum + (r.content?.length ?? 0), 0);
    return { ...value, results, resultCount: results.length, contextCharacters,
      omittedContextCharacters: (value.omittedContextCharacters ?? 0) + originalCharacters - contextCharacters,
      omittedResultCount: (value.omittedResultCount ?? 0) + sources.length - results.length };
  };
  const fits = (data: unknown) => Buffer.byteLength(JSON.stringify(data)) <= MAX_OUTPUT_BYTES;
  const full = candidate(Math.max(0, ...sources.map(r => r.content?.length ?? 0)));
  if (fits(full)) return full;
  // Metadata can dominate. Drop tail sources rather than fabricate shortened URLs.
  // Refill the remaining byte budget with evidence once the retained metadata fits.
  for (let count = sources.length; count >= 0; count--) {
    let best = candidate(0, count);
    if (!fits(best)) continue;
    let low = 0;
    let high = Math.max(0, ...sources.slice(0, count).map(r => r.content?.length ?? 0));
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const current = candidate(middle, count);
      if (fits(current)) { best = current; low = middle + 1; }
      else high = middle - 1;
    }
    return best;
  }
  return { truncated: true, message: "Code search metadata exceeded 50KB; refine the request." };
}
