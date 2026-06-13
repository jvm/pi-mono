import test from "node:test";
import assert from "node:assert/strict";
import { ExaMcpProvider } from "../src/providers/exa-mcp.ts";
import { ExaProvider } from "../src/providers/exa.ts";
import { TinyFishProvider } from "../src/providers/tinyfish.ts";
import { BraveProvider } from "../src/providers/brave.ts";
import { Context7Provider } from "../src/providers/context7.ts";
import { FirecrawlProvider } from "../src/providers/firecrawl.ts";
import { resolveConfig } from "../src/config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = (apiKeys = {}) => ({ provider_search: "exa_mcp", provider_fetch: "exa_mcp", apiKeys, markdownNew: { method: "auto", retainImages: false } });

test("Exa MCP stores mcp-session-id header and sends it on tools/call", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(init);
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-123" } });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/call") {
      assert.equal(init.headers["mcp-session-id"], "session-123");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { results: [{ title: "T", url: "https://example.com", snippet: "S" }] } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected ${body.method}`);
  };
  try {
    const provider = new ExaMcpProvider(cfg());
    const result = await provider.search({ query: "q" });
    assert.equal(result.results[0].url, "https://example.com");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("keyed providers fail clearly when keys are missing", () => {
  assert.throws(() => new ExaProvider(cfg()), /EXA_API_KEY/);
  assert.throws(() => new TinyFishProvider(cfg()), /TINYFISH_API_KEY/);
  assert.throws(() => new BraveProvider(cfg()), /BRAVE_SEARCH_API_KEY/);
  assert.throws(() => new FirecrawlProvider(cfg()), /FIRECRAWL_API_KEY/);
  assert.throws(() => new Context7Provider(cfg()), /CONTEXT7_API_KEY/);
});

test("config-file API keys override environment for all keyed providers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-"));
  writeFileSync(join(cwd, ".pi-web-kit.json"), JSON.stringify({ apiKeys: { exa: "file-exa", tinyfish: "file-tiny", brave: "file-brave", firecrawl: "file-fire", context7: "file-context7" } }));
  const cfg = resolveConfig({}, cwd, {
    EXA_API_KEY: "env-exa",
    TINYFISH_API_KEY: "env-tiny",
    BRAVE_SEARCH_API_KEY: "env-brave",
    FIRECRAWL_API_KEY: "env-fire",
    CONTEXT7_API_KEY: "env-context7",
  });
  assert.equal(cfg.apiKeys.exa, "file-exa");
  assert.equal(cfg.apiKeys.tinyfish, "file-tiny");
  assert.equal(cfg.apiKeys.brave, "file-brave");
  assert.equal(cfg.apiKeys.firecrawl, "file-fire");
  assert.equal(cfg.apiKeys.context7, "file-context7");
});


test("Context7 provider resolves libraries and fetches docs", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.authorization, "Bearer ctx-key");
    if (String(url).includes("/libs/search")) {
      return new Response(JSON.stringify({ results: [{ id: "/vercel/next.js", title: "Next.js", versions: ["v16.0.0"] }], searchFilterApplied: false }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/context")) {
      assert(String(url).includes("libraryId=%2Fvercel%2Fnext.js%40v16.0.0"));
      return new Response(JSON.stringify({ codeSnippets: [{ codeTitle: "Middleware", codeList: [{ language: "ts", code: "export function middleware() {}" }] }], infoSnippets: [{ content: "Docs" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const provider = new Context7Provider(cfg({ context7: "ctx-key" }));
    const found = await provider.searchLibraries({ libraryName: "next", query: "middleware", limit: 1 });
    assert.equal(found.results[0].id, "/vercel/next.js");
    const docs = await provider.getDocs({ libraryId: "/vercel/next.js", version: "v16.0.0", query: "middleware" });
    assert.equal(docs.libraryId, "/vercel/next.js@v16.0.0");
    assert.equal(docs.codeSnippets[0].codeTitle, "Middleware");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});


test("Exa Code provider calls context endpoint", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.exa.ai/context");
    assert.equal(init.headers["x-api-key"], "exa-key");
    assert.deepEqual(JSON.parse(init.body), { query: "react hooks", tokensNum: 5000 });
    return new Response(JSON.stringify({ query: "react hooks", response: "example", resultsCount: 3, outputTokens: 120 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const provider = new ExaProvider(cfg({ exa: "exa-key" }));
    const result = await provider.searchCode({ query: "react hooks", tokensNum: 5000 });
    assert.equal(result.response, "example");
    assert.equal(result.resultsCount, 3);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Exa fetch falls back to TinyFish first when no crawl results are returned", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("api.exa.ai/contents")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("api.fetch.tinyfish.ai")) {
      assert.equal(init.headers["X-API-Key"], "tiny-key");
      return new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "Fallback", markdown: "fallback content" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const provider = new ExaProvider(cfg({ exa: "exa-key", tinyfish: "tiny-key", firecrawl: "fire-key" }));
    const result = await provider.fetch({ url: "https://example.com" });
    assert.equal(result.provider, "exa");
    assert.equal(result.results[0].content, "fallback content");
    assert.equal(result.results[0].metadata.fallbackProvider, "tinyfish");
    assert.deepEqual(calls, ["https://api.exa.ai/contents", "https://api.fetch.tinyfish.ai"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Exa fetch skips unavailable keyed fallbacks and uses markdown.new", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("api.exa.ai/contents")) {
      return new Response(JSON.stringify({ results: [{ url: "https://example.com", text: "No crawl results found" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://markdown.new/") {
      return new Response("markdown.new content", { status: 200, headers: { "content-type": "text/markdown" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const provider = new ExaProvider(cfg({ exa: "exa-key" }));
    const result = await provider.fetch({ url: "https://example.com" });
    assert.equal(result.results[0].content, "markdown.new content");
    assert.equal(result.results[0].metadata.fallbackProvider, "markdown_new");
    assert.deepEqual(calls, ["https://api.exa.ai/contents", "https://markdown.new/"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
