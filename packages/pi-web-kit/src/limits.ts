import type { SearchProviderName } from "./types.js";

export const MAX_QUERY_COUNT = 5;
export const MAX_URL_COUNT = 10;
export const MAX_URL_LENGTH = 2_048;
export const MAX_NUM_RESULTS = 20;
export const DEFAULT_NUM_RESULTS = 10;
export const DEFAULT_SEARCH_CONTEXT_TOKENS = 8_192;
export const MAX_SEARCH_CONTEXT_TOKENS = 10_000;
export const SEARCH_RESULT_LIMITS: Readonly<Record<SearchProviderName, number | undefined>> = {
  exa: 100,
  brave: 50,
  firecrawl: 100,
  tinyfish: undefined,
};
export const TINYFISH_MAX_PAGE = 10;
export const MAX_OFFSET = 10_000_000;
export const MAX_LIMIT = 100_000;
export const DEFAULT_FETCH_LIMIT = 30_000;
export const MULTI_FETCH_LIMIT = 8_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const FETCH_CACHE_MAX_ENTRIES = 100;
export const FETCH_CACHE_MAX_BYTES = 20 * 1024 * 1024;
export const FETCH_CACHE_TTL_MS = 30 * 60 * 1000;
export const FETCH_CONCURRENCY = 3;

export function capSearchResultLimit(provider: SearchProviderName, requested: number): number {
  return Math.min(requested, SEARCH_RESULT_LIMITS[provider] ?? requested);
}

export function applySearchContextBudget(results: Array<{ content?: string; [key: string]: unknown }>, maxCharacters: number) {
  let remaining = maxCharacters;
  let remainingContentResults = results.filter((result) => typeof result.content === "string").length;
  let contextCharacters = 0;
  let omittedContextCharacters = 0;
  const bounded = results.map((result) => {
    if (typeof result.content !== "string") return result;
    const share = Math.max(0, Math.floor(remaining / remainingContentResults));
    const content = safePrefix(result.content, share);
    remaining -= content.length;
    remainingContentResults--;
    contextCharacters += content.length;
    omittedContextCharacters += result.content.length - content.length;
    return { ...result, content };
  });
  return { results: bounded, contextCharacters, omittedContextCharacters };
}

export function safePrefix(value: string, maxChars: number): string {
  let end = Math.min(value.length, maxChars);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end);
}
