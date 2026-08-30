import type { SearchProviderName } from "./types.js";

export const MAX_QUERY_COUNT = 5;
export const MAX_URL_COUNT = 10;
export const MAX_URL_LENGTH = 2_048;
export const MAX_NUM_RESULTS = 20;
export const DEFAULT_NUM_RESULTS = 10;
export const SEARCH_RESULT_LIMITS: Readonly<Record<SearchProviderName, number | undefined>> = {
  exa_mcp: 100,
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
