import { asSnippet, fetchWithTimeout, normalizeUrls } from "../http.js";
import { DEFAULT_NUM_RESULTS } from "../limits.js";
import { urlsMatch } from "../urls.js";
import type { FetchInput, FetchProvider, SearchInput, SearchProvider, WebKitConfig } from "../types.js";
import { applyExaFetchFallbacks } from "./fallback.js";

export class ExaMcpProvider implements SearchProvider, FetchProvider {
  private sessionId?: string;
  private nextId = 1;
  constructor(private config: WebKitConfig) {}

  async search(input: SearchInput, signal?: AbortSignal) {
    const result = await this.callTool("web_search_exa", { query: input.query, numResults: input.numResults ?? DEFAULT_NUM_RESULTS }, signal);
    return { provider: "exa_mcp" as const, query: input.query, results: normalizeSearch(result) };
  }

  async fetch(input: FetchInput, signal?: AbortSignal) {
    const urls = normalizeUrls(input);
    const result = await this.callTool("web_fetch_exa", { urls }, signal);
    const pages = normalizeFetch(result, urls);
    return applyExaFetchFallbacks(this.config, input, urls, { provider: "exa_mcp" as const, results: pages }, signal);
  }

  private async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    await this.initialize(signal);
    return this.rpc("tools/call", { name, arguments: args }, signal);
  }

  private async initialize(signal?: AbortSignal) {
    if (this.sessionId) return;
    const data = await this.rpcRaw("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-web-kit", version: "0.1.0" } }, signal);
    this.sessionId = data.sessionId ?? data.payload?.sessionId;
    if (!this.sessionId) throw new Error("Exa MCP initialize did not return an mcp-session-id response header.");
    await this.rpcRaw("notifications/initialized", undefined, signal, true);
  }

  private async rpc(method: string, params: unknown, signal?: AbortSignal) {
    const data = await this.rpcRaw(method, params, signal);
    if (data.payload?.error) throw new Error(data.payload.error.message ?? JSON.stringify(data.payload.error));
    return data.payload?.result ?? data.payload;
  }

  private async rpcRaw(method: string, params: unknown, signal?: AbortSignal, notification = false): Promise<{ payload?: any; sessionId?: string }> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.config.apiKeys.exa) headers["x-api-key"] = this.config.apiKeys.exa;
    const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: this.nextId++, method, params };
    const res = await fetchWithTimeout("https://mcp.exa.ai/mcp", { method: "POST", headers, body: JSON.stringify(body), signal, timeoutMs: 45_000 });
    const text = await res.text();
    if (!res.ok) throw new Error(`Exa MCP ${method} failed: ${res.status} ${res.statusText}: ${text.slice(0, 1000)}`);
    if (notification) return { sessionId: this.sessionId };
    const sessionId = res.headers.get("mcp-session-id") ?? undefined;
    const payload = parseMcpResponse(text, res.headers.get("content-type") ?? "");
    return { payload, sessionId };
  }
}

function parseMcpResponse(text: string, contentType: string): any {
  if (!text.trim()) return undefined;
  if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    return data ? JSON.parse(data) : undefined;
  }
  return JSON.parse(text);
}

function textFromContent(result: any): string {
  const content = result?.content ?? result;
  if (Array.isArray(content)) return content.map((c) => typeof c === "string" ? c : c.text ?? JSON.stringify(c)).join("\n");
  return typeof content === "string" ? content : JSON.stringify(content);
}

function normalizeSearch(result: any) {
  const structured = result?.structuredContent ?? result?.result ?? result;
  const list = structured.results ?? structured.data ?? structured.items;
  if (Array.isArray(list)) return list.map((r: any, i: number) => ({ title: r.title, url: r.url, snippet: asSnippet(r.snippet ?? r.text ?? r.summary ?? r.highlights), siteName: r.siteName, position: i + 1 })).filter((r: any) => r.url);
  const text = textFromContent(result);
  const urls = [...text.matchAll(/https?:\/\/[^\s)\]}>"']+/g)].map((m) => m[0]);
  return [...new Set(urls)].map((url, i) => ({ url, snippet: i === 0 ? text.slice(0, 1000) : undefined, position: i + 1 }));
}

function normalizeFetch(result: any, urls: string[]) {
  const structured = result?.structuredContent ?? result?.result ?? result;
  const list = structured.results ?? structured.data ?? structured.pages;
  if (Array.isArray(list)) return urls.map((url, i) => {
    const r = list.find((x: any) => urlsMatch(x.url, url)) ?? list[i];
    return r ? { url, title: r.title, content: r.markdown ?? r.text ?? r.content ?? r.html, format: "markdown" as const, metadata: r, error: r.error } : { url, error: "No content returned by Exa MCP." };
  });
  const text = textFromContent(result);
  return urls.length <= 1 ? [{ url: urls[0] ?? "", content: text, format: "markdown" as const }] : urls.map((url) => ({ url, content: text, format: "markdown" as const }));
}
