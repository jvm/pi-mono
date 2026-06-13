export type SearchProviderName = "exa_mcp" | "exa" | "tinyfish" | "brave" | "firecrawl";
export type FetchProviderName = "exa_mcp" | "exa" | "tinyfish" | "markdown_new" | "firecrawl";
export type FetchFormat = "markdown" | "html" | "json";

export interface WebKitConfig {
  provider_search: SearchProviderName;
  provider_fetch: FetchProviderName;
  apiKeys: Partial<Record<"exa" | "tinyfish" | "brave" | "firecrawl" | "context7", string>>;
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

export interface Context7LibrarySearchInput {
  libraryName: string;
  query?: string;
  fast?: boolean;
  limit?: number;
}

export interface Context7LibrarySearchResult {
  provider: "context7";
  libraryName: string;
  query: string;
  searchFilterApplied?: boolean;
  results: Array<{
    id: string;
    title?: string;
    description?: string;
    branch?: string;
    lastUpdateDate?: string;
    state?: string;
    totalTokens?: number;
    totalSnippets?: number;
    stars?: number;
    trustScore?: number;
    benchmarkScore?: number;
    versions?: string[];
  }>;
}

export interface Context7ContextInput {
  libraryId: string;
  query: string;
  version?: string;
  type?: "json";
  fast?: boolean;
  limit?: number;
}

export interface Context7DocsResult {
  provider: "context7";
  libraryId: string;
  query: string;
  codeSnippets: Array<{
    codeTitle?: string;
    codeDescription?: string;
    codeLanguage?: string;
    codeTokens?: number;
    codeId?: string;
    pageTitle?: string;
    sourceFile?: string;
    isDynamic?: boolean;
    codeList?: Array<{ language: string; code: string }>;
  }>;
  infoSnippets: Array<{ pageId?: string; breadcrumb?: string; content: string; contentTokens?: number }>;
  rules?: unknown;
}

export interface ExaCodeInput {
  query: string;
  tokensNum?: "dynamic" | number;
}

export interface ExaCodeResult {
  provider: "exa";
  query: string;
  response: string;
  resultsCount?: number;
  searchTime?: number;
  outputTokens?: number;
  requestId?: string;
}

export interface SearchProvider {
  search(input: SearchInput, signal?: AbortSignal): Promise<WebSearchResult>;
}

export interface FetchProvider {
  fetch(input: FetchInput, signal?: AbortSignal): Promise<WebFetchResult>;
}
