import { requestJson } from "../http.js";
import type { Context7ContextInput, Context7DocsResult, Context7LibrarySearchInput, Context7LibrarySearchResult, WebKitConfig } from "../types.js";
import { requireKey } from "../config.js";

const BASE_URL = "https://context7.com/api/v2";

export class Context7Provider {
  private key: string;
  constructor(config: WebKitConfig) { this.key = requireKey(config, "context7"); }

  async searchLibraries(input: Context7LibrarySearchInput, signal?: AbortSignal): Promise<Context7LibrarySearchResult> {
    const query = input.query ?? input.libraryName;
    const params = new URLSearchParams({ libraryName: input.libraryName, query });
    addFastParam(params, input.fast);
    const data = await requestJson<any>(`${BASE_URL}/libs/search?${params}`, {
      headers: this.headers(),
      signal,
      timeoutMs: 30_000,
    });
    const limit = input.limit ?? 10;
    return {
      provider: "context7",
      libraryName: input.libraryName,
      query,
      searchFilterApplied: data.searchFilterApplied,
      results: (data.results ?? []).slice(0, limit).map(toLibraryResult).filter((r: any) => r.id),
    };
  }

  async getDocs(input: Context7ContextInput, signal?: AbortSignal): Promise<Context7DocsResult> {
    const libraryId = withVersion(input.libraryId, input.version);
    const params = new URLSearchParams({ libraryId, query: input.query, type: input.type ?? "json" });
    addFastParam(params, input.fast);
    const data = await requestJson<any>(`${BASE_URL}/context?${params}`, {
      headers: this.headers(),
      signal,
      timeoutMs: 45_000,
    });
    const limit = input.limit ?? 10;
    return {
      provider: "context7",
      libraryId,
      query: input.query,
      codeSnippets: (data.codeSnippets ?? []).slice(0, limit).map(toCodeSnippet),
      infoSnippets: (data.infoSnippets ?? []).slice(0, limit).map(toInfoSnippet),
      rules: data.rules,
    };
  }

  private headers(): HeadersInit {
    return { authorization: `Bearer ${this.key}` };
  }
}

function addFastParam(params: URLSearchParams, fast?: boolean) {
  if (fast != null) params.set("fast", String(fast));
}

function toLibraryResult(r: any) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    branch: r.branch,
    lastUpdateDate: r.lastUpdateDate,
    state: r.state,
    totalTokens: r.totalTokens,
    totalSnippets: r.totalSnippets,
    stars: r.stars,
    trustScore: r.trustScore,
    benchmarkScore: r.benchmarkScore,
    versions: r.versions,
  };
}

function toCodeSnippet(s: any) {
  return {
    codeTitle: s.codeTitle,
    codeDescription: s.codeDescription,
    codeLanguage: s.codeLanguage,
    codeTokens: s.codeTokens,
    codeId: s.codeId,
    pageTitle: s.pageTitle,
    sourceFile: s.sourceFile,
    isDynamic: s.isDynamic,
    codeList: s.codeList,
  };
}

function toInfoSnippet(s: any) {
  return {
    pageId: s.pageId,
    breadcrumb: s.breadcrumb,
    content: s.content,
    contentTokens: s.contentTokens,
  };
}

function withVersion(libraryId: string, version?: string): string {
  const id = libraryId.trim();
  const v = version?.trim();
  if (!v) return id;
  if (id.endsWith(`@${v}`) || id.endsWith(`/${v}`)) return id;
  return `${id}@${v}`;
}
