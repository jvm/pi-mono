export type SearchProviderName = "exa_mcp" | "exa" | "tinyfish" | "brave" | "firecrawl";
export type FetchProviderName = "exa_mcp" | "exa" | "tinyfish" | "markdown_new" | "firecrawl";
export type FetchFormat = "markdown" | "html" | "json";

export interface WebKitConfig {
  provider_search: SearchProviderName;
  provider_fetch: FetchProviderName;
  apiKeys: Partial<Record<"exa" | "tinyfish" | "brave" | "firecrawl", string>>;
  markdownNew: { method: "auto" | "ai" | "browser"; retainImages: boolean };
}

export interface SearchInput {
  query: string;
  numResults?: number;
  [key: string]: unknown;
}

export interface WebSearchResult {
  provider: SearchProviderName;
  query: string;
  results: Array<{ title?: string; url: string; snippet?: string; siteName?: string; position?: number }>;
}

export interface FetchInput {
  url?: string;
  urls?: string[];
  offset?: number;
  limit?: number;
  refresh?: boolean;
  format?: FetchFormat;
  links?: boolean;
  imageLinks?: boolean;
  [key: string]: unknown;
}

export interface WebFetchResult {
  provider: FetchProviderName;
  results: Array<{ url: string; content?: string; format?: FetchFormat; title?: string; metadata?: Record<string, unknown>; error?: string }>;
}

export interface SearchProvider {
  search(input: SearchInput, signal?: AbortSignal): Promise<WebSearchResult>;
}

export interface FetchProvider {
  fetch(input: FetchInput, signal?: AbortSignal): Promise<WebFetchResult>;
}
