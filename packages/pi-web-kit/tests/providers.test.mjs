import test from "node:test";
import assert from "node:assert/strict";
import { ExaMcpProvider } from "../src/providers/exa-mcp.ts";
import { ExaProvider } from "../src/providers/exa.ts";
import { TinyFishProvider } from "../src/providers/tinyfish.ts";
import { BraveProvider } from "../src/providers/brave.ts";
import { Context7Provider } from "../src/providers/context7.ts";
import { FirecrawlProvider } from "../src/providers/firecrawl.ts";
import { resolveConfig } from "../src/config.ts";
import { capSearchResultLimit } from "../src/limits.ts";
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

test("search result limits are capped by provider capability", () => {
  assert.equal(capSearchResultLimit("exa", 101), 100);
  assert.equal(capSearchResultLimit("exa_mcp", 101), 100);
  assert.equal(capSearchResultLimit("brave", 51), 50);
  assert.equal(capSearchResultLimit("firecrawl", 101), 100);
  assert.equal(capSearchResultLimit("tinyfish", 101), 101);
});

test("Brave maps the effective result limit to native parameters", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get("count"), "50");
    assert.equal(params.get("maximum_number_of_urls"), "50");
    assert.equal(params.get("maximum_number_of_tokens"), "2000");
    assert.equal(params.get("context_threshold_mode"), "strict");
    return new Response(JSON.stringify({ grounding: { generic: [
      { title: "One", url: "https://one.test", snippets: ["x".repeat(2_000)] },
      { title: "Two", url: "https://two.test", snippets: ["two"] },
    ] }, sources: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new BraveProvider(cfg({ brave: "test-key" })).search({ query: "q", numResults: 50, contextTokens: 2_000, contextThresholdMode: "strict" });
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].snippet.length, 1_000);
    assert.equal(result.results[0].content.length, 2_000);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Brave uses POST for Goggles and caps its native query constraints", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.search.brave.com/res/v1/llm/context");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.goggles, ["one", "two"]);
    assert(body.q.length <= 400);
    assert(body.q.split(" ").length <= 50);
    return new Response(JSON.stringify({ grounding: { generic: [] }, sources: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const query = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    await new BraveProvider(cfg({ brave: "test-key" })).search({ query, goggles: ["one", "two"] });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Exa maps generic context intent to bounded native text", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.contents, { highlights: { query: "compare implementations" }, text: { maxCharacters: 2_000 } });
    return new Response(JSON.stringify({ results: [{ title: "T", url: "https://example.test", text: "x".repeat(1_500) }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new ExaProvider(cfg({ exa: "test-key" })).search({ query: "q", purpose: "compare implementations", numResults: 4, contextTokens: 2_000 });
    assert.equal(result.results[0].content.length, 1_500);
    assert.equal(result.results[0].snippet.length, 1_000);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("TinyFish paginates without its ignored limit parameter and slices returned results", async () => {
  const pages = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.has("limit"), false);
    assert.equal(parsed.searchParams.get("purpose"), "find implementation guidance");
    assert.equal(parsed.searchParams.get("include_domains"), "example.test");
    const page = Number(parsed.searchParams.get("page"));
    pages.push(page);
    const start = page * 10;
    return new Response(JSON.stringify({
      total_results: 30,
      results: Array.from({ length: 10 }, (_, i) => ({ title: `R${start + i}`, url: `https://example.test/${start + i}` })),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new TinyFishProvider(cfg({ tinyfish: "test-key" })).search({ query: "q", purpose: "find implementation guidance", includeDomains: ["example.test"], numResults: 15 });
    assert.deepEqual(pages, [0, 1]);
    assert.equal(result.results.length, 15);
    assert.equal(result.results[14].position, 15);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("TinyFish never requests a page above its service maximum", async () => {
  const pages = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return new Response(JSON.stringify({ results: [{ url: `https://example.test/${page}` }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new TinyFishProvider(cfg({ tinyfish: "test-key" })).search({ query: "q", numResults: 100 });
    assert.deepEqual(pages, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(result.results.length, 11);
    assert.equal(result.effectiveResultLimit, 11);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("TinyFish normalizes incompatible freshness filters before the request", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get("pub_year_min"), "2020");
    assert.equal(params.get("pub_year_max"), "2025");
    assert.equal(params.has("recency_minutes"), false);
    assert.equal(params.has("after_date"), false);
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await new TinyFishProvider(cfg({ tinyfish: "test-key" })).search({
      query: "q",
      domainType: "research_paper",
      pubYearMin: 2025,
      pubYearMax: 2020,
      recencyMinutes: 60,
      afterDate: "2025-01-01",
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("TinyFish fetch uses cache, intent, selector options, and exact per-URL errors", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), {
      urls: ["https://failed.test/", "https://ok.test/"],
      purpose: "compare pages",
      format: "markdown",
      ttl: 0,
      per_url_timeout_ms: 45_000,
      include_selectors: ["main"],
    });
    return new Response(JSON.stringify({
      results: [{ url: "https://ok.test/", final_url: "https://ok.test/final", text: "ok" }],
      errors: [{ url: "https://failed.test/", error: "bot_blocked", status: 403 }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new TinyFishProvider(cfg({ tinyfish: "test-key" })).fetch({
      urls: ["https://failed.test", "https://ok.test"],
      purpose: "compare pages",
      refresh: true,
      perUrlTimeoutMs: 45_000,
      includeSelectors: ["main"],
    });
    assert.match(result.results[0].error, /bot_blocked.*403/);
    assert.equal(result.results[1].url, "https://ok.test/final");
    assert.equal(result.results[1].content, "ok");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("TinyFish extracts only enough top results for the requested context budget", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.search.tinyfish.ai")) {
      return new Response(JSON.stringify({ results: Array.from({ length: 20 }, (_, i) => ({ title: `R${i}`, url: `https://e.test/${i}`, snippet: "s" })) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.urls.length, 2);
    return new Response(JSON.stringify({ results: body.urls.map((item) => ({ url: item, text: "x".repeat(3_000) })) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new TinyFishProvider(cfg({ tinyfish: "test-key" })).search({ query: "q", numResults: 20, contextTokens: 1_024 });
    assert.equal(result.results.length, 20);
    assert.equal(result.results.filter((item) => item.content).length, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Firecrawl only enables scrape-on-search for explicit expanded context", async () => {
  const bodies = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: { web: [{ title: "T", url: "https://e.test", markdown: "full content", description: "short" }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const provider = new FirecrawlProvider(cfg({ firecrawl: "test-key" }));
    await provider.search({ query: "q", numResults: 1 });
    const expanded = await provider.search({ query: "q", numResults: 1, contextTokens: 2_000 });
    assert.equal(bodies[0].scrapeOptions, undefined);
    assert.deepEqual(bodies[1].scrapeOptions, { formats: ["markdown"], onlyMainContent: true });
    assert.equal(expanded.results[0].content, "full content");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Exa MCP rejects tool-level errors", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s" } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "provider rejected request" }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(() => new ExaMcpProvider(cfg()).search({ query: "q" }), /provider rejected request/);
  } finally {
    globalThis.fetch = oldFetch;
  }
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
