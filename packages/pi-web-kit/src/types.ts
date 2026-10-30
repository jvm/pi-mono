export type SearchProviderName = "exa" | "tinyfish" | "brave" | "firecrawl";
export type FetchProviderName = "exa" | "tinyfish" | "markdown_new" | "firecrawl";
export type FetchFormat = "markdown" | "html" | "json";

export interface WebKitConfig {
  enabled: boolean;
  provider_search: SearchProviderName;
  provider_fetch: FetchProviderName;
  apiKeys: Partial<Record<"exa" | "tinyfish" | "brave" | "firecrawl" | "context7", string>>;
  markdownNew: { method: "auto" | "ai" | "browser"; retainImages: boolean };
}

export interface SearchInput {
  query: string;
  numResults?: number;
  contextTokens?: number;
  purpose?: string;
  [key: string]: unknown;
}

export interface WebSearchResult {
  provider: SearchProviderName;
  query: string;
  effectiveResultLimit?: number;
  notices?: ExaNotice[];
  omittedNoticeCount?: number;
  omittedNoContentCount?: number;
  results: Array<{ title?: string; url: string; snippet?: string; content?: string; contentFormat?: "markdown" | "text"; siteName?: string; publishedDate?: string; position?: number }>;
}

export interface ExaNotice {
  code: string;
  message: string;
  path?: string;
}

/** Non-model diagnostics: no queries, page text, headers, or warning messages. */
export interface ExaDiagnostic {
  endpoint: "/search";
  durationMs: number;
  requestId?: string;
  searchType?: string;
  searchTime?: number;
  costDollars?: number;
  warnings?: Array<{ code: string; path?: string }>;
  omittedWarningCount?: number;
  error?: "http" | "timeout" | "cancelled" | "invalid-response" | "network";
  httpStatus?: number;
}

export type ExaDiagnosticSink = (diagnostic: ExaDiagnostic) => void;

export interface FetchInput {
  url?: string;
  urls?: string[];
  offset?: number;
  limit?: number;
  refresh?: boolean;
  maxAgeMs?: number;
  format?: FetchFormat;
  links?: boolean;
  imageLinks?: boolean;
  purpose?: string;
  ttl?: number;
  perUrlTimeoutMs?: number;
  includeSelectors?: string[];
  excludeSelectors?: string[];
  [key: string]: unknown;
}

export interface WebFetchResult {
  provider: FetchProviderName;
  // Internal association survives canonical redirects; never projected as raw metadata.
  results: Array<{ url: string; requestedUrl?: string; content?: string; format?: FetchFormat; title?: string;
    links?: unknown; imageLinks?: unknown; metadata?: Record<string, unknown>; error?: string }>;
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
  purpose: string;
  numResults?: number;
  contextTokens?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface ExaCodeResult {
  provider: "exa";
  query: string;
  searchType: "auto";
  maxAgeHours: 0;
  requestedResultLimit: number;
  effectiveResultLimit: number;
  requestedContextTokens?: number;
  effectiveContextTokens: number;
  contextCharacters: number;
  omittedContextCharacters?: number;
  resultCount: number;
  omittedResultCount?: number;
  omittedNoContentCount?: number;
  notices?: ExaNotice[];
  omittedNoticeCount?: number;
  results: WebSearchResult["results"];
}

export interface SearchProvider {
  search(input: SearchInput, signal?: AbortSignal): Promise<WebSearchResult>;
}

export interface FetchProvider {
  fetch(input: FetchInput, signal?: AbortSignal): Promise<WebFetchResult>;
}
