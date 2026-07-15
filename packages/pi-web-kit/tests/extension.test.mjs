import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { buildCacheKey, buildCodeSearchSchema, buildFetchSchema, buildLibraryDocsSchema, buildLibrarySearchSchema, buildSearchSchema, fetchWithCache, jsonToolResult, pageSlice } from "../extensions/index.ts";

const propNames = (schema) => Object.keys(schema.properties ?? {}).sort();

test("active search schemas are provider-tailored", () => {
  assert.deepEqual(propNames(buildSearchSchema("exa_mcp")), ["numResults", "queries", "query"]);
  assert(propNames(buildSearchSchema("firecrawl")).includes("scrape"));
  assert(propNames(buildSearchSchema("firecrawl")).includes("scrapeOptions"));
  assert(propNames(buildSearchSchema("firecrawl")).includes("includeDomains"));
});

test("active fetch schemas are provider-tailored", () => {
  assert(propNames(buildFetchSchema("tinyfish")).includes("format"));
  assert(propNames(buildFetchSchema("tinyfish")).includes("links"));
  assert(propNames(buildFetchSchema("tinyfish")).includes("imageLinks"));
  assert(propNames(buildFetchSchema("markdown_new")).includes("method"));
  assert(propNames(buildFetchSchema("markdown_new")).includes("retainImages"));
  assert.deepEqual(propNames(buildFetchSchema("exa_mcp")), ["limit", "offset", "refresh", "url", "urls"]);
});

test("missing trust API defaults to untrusted and repeated session starts do not duplicate tools", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-"));
  writeFileSync(join(cwd, ".pi-web-kit.json"), JSON.stringify({ provider_fetch: "markdown_new" }));
  const tools = [];
  let sessionStart;
  extension({
    registerFlag() {},
    getFlag() { return undefined; },
    registerTool(tool) { tools.push(tool); },
    on(name, handler) { if (name === "session_start") sessionStart = handler; },
  });
  sessionStart({}, { cwd });
  sessionStart({}, { cwd });
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert(names.includes("web_fetch"));
  assert(names.includes("web_search"));
  assert(!propNames(tools.find((tool) => tool.name === "web_fetch").parameters).includes("method"));
});

test("changed session config refreshes provider-tailored tools", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-"));
  writeFileSync(join(cwd, ".pi-web-kit.json"), JSON.stringify({ provider_fetch: "markdown_new" }));
  const tools = [];
  let sessionStart;
  extension({
    registerFlag() {},
    getFlag() { return undefined; },
    registerTool(tool) { tools.push(tool); },
    on(name, handler) { if (name === "session_start") sessionStart = handler; },
  });
  sessionStart({}, { cwd, isProjectTrusted: () => false });
  sessionStart({}, { cwd, isProjectTrusted: () => true });
  const fetchTools = tools.filter((tool) => tool.name === "web_fetch");
  assert.equal(fetchTools.length, 2);
  assert(!propNames(fetchTools[0].parameters).includes("method"));
  assert(propNames(fetchTools[1].parameters).includes("method"));
});

test("project config controls tool schemas only for trusted projects", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-"));
  writeFileSync(join(cwd, ".pi-web-kit.json"), JSON.stringify({ provider_fetch: "markdown_new" }));
  const trusted = registerWithFlags({}, { cwd, trusted: true }).find((tool) => tool.name === "web_fetch");
  const untrusted = registerWithFlags({}, { cwd, trusted: false }).find((tool) => tool.name === "web_fetch");
  assert(propNames(trusted.parameters).includes("method"));
  assert(!propNames(untrusted.parameters).includes("method"));
});

test("CLI fetch provider override controls startup schema", () => {
  const oldTelemetry = process.env.PI_TELEMETRY;
  process.env.PI_TELEMETRY = "0";
  try {
    const tools = [];
    let sessionStart;
    const pi = {
      registerFlag() {},
      getFlag(name) { return name === "web-provider-fetch" ? "markdown_new" : undefined; },
      registerTool(tool) { tools.push(tool); },
      on(name, handler) { if (name === "session_start") sessionStart = handler; },
    };
    extension(pi);
    sessionStart({}, { cwd: mkdtempSync(join(tmpdir(), "pi-web-kit-")), isProjectTrusted: () => true });
    const fetchTool = tools.find((t) => t.name === "web_fetch");
    assert(fetchTool);
    assert(propNames(fetchTool.parameters).includes("method"));
    assert(propNames(fetchTool.parameters).includes("retainImages"));
  } finally {
    if (oldTelemetry === undefined) delete process.env.PI_TELEMETRY;
    else process.env.PI_TELEMETRY = oldTelemetry;
  }
});

test("cache keys include canonical URL and config-derived fetch defaults", () => {
  const a = buildCacheKey("markdown_new", "https://example.com/page#frag", {}, { markdownNew: { method: "auto", retainImages: false } });
  const b = buildCacheKey("markdown_new", "https://example.com/page", {}, { markdownNew: { method: "browser", retainImages: false } });
  assert.notEqual(a, b);
  assert(a.endsWith("https://example.com/page"));
  assert.notEqual(buildCacheKey("firecrawl", "https://e.test", {}, {}), buildCacheKey("firecrawl", "https://e.test", { onlyMainContent: false }, {}));
});

test("range metadata includes previous/next and offset truncation", () => {
  const result = pageSlice({ provider: "exa_mcp", cacheKey: "k", url: "u", content: "abcdef", format: "markdown", fetchedAt: 1 }, 2, 2, true, false);
  assert.equal(result.content, "cd");
  assert.deepEqual(result.range, { offset: 2, limit: 2, returned: 2, total: 6, truncated: true, hasPrevious: true, hasNext: true, nextOffset: 4 });
  assert.equal(result.cacheKey, undefined);
});

test("search schema rejects unknown properties in principle", () => {
  assert.equal(buildSearchSchema("exa_mcp").additionalProperties, false);
  assert.equal(buildFetchSchema("firecrawl").additionalProperties, false);
  assert.equal(buildFetchSchema("firecrawl").properties.waitFor.minimum, 0);
  assert.equal(buildLibrarySearchSchema().additionalProperties, false);
  assert.equal(buildLibraryDocsSchema().additionalProperties, false);
  assert.equal(buildCodeSearchSchema().additionalProperties, false);
});

// Developer-search tools are intentionally registered only when their API keys
// exist so agents do not spend prompt tokens on unavailable capabilities.
// This test scrubs the relevant process env keys for deterministic startup.
test("developer-search tools are hidden unless backing API keys are available", () => {
  const oldExa = process.env.EXA_API_KEY;
  const oldContext7 = process.env.CONTEXT7_API_KEY;
  try {
    delete process.env.EXA_API_KEY;
    delete process.env.CONTEXT7_API_KEY;
    assert.deepEqual(registerWithFlags({}).map((t) => t.name).sort(), ["web_fetch", "web_search"]);

    process.env.CONTEXT7_API_KEY = "ctx7sk_test";
    assert.deepEqual(registerWithFlags({}).map((t) => t.name).sort(), ["library_docs", "library_search", "web_fetch", "web_search"]);

    process.env.EXA_API_KEY = "exa-test";
    assert.deepEqual(registerWithFlags({}).map((t) => t.name).sort(), ["code_search", "library_docs", "library_search", "web_fetch", "web_search"]);
  } finally {
    if (oldExa === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = oldExa;
    if (oldContext7 === undefined) delete process.env.CONTEXT7_API_KEY;
    else process.env.CONTEXT7_API_KEY = oldContext7;
  }
});

test("web_search returns grouped multi-query output with bounded details", async () => {
  const tools = registerWithFlags({});
  const searchTool = tools.find((t) => t.name === "web_search");
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s" } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/call") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { results: [{ title: body.params.arguments.query, url: `https://example.com/${body.params.arguments.query}` }] } } }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected ${body.method}`);
  };
  try {
    const out = await searchTool.execute("id", { queries: ["one", "two"] }, undefined, undefined, { cwd: mkdtempSync(join(tmpdir(), "pi-web-kit-")), isProjectTrusted: () => true });
    const parsed = JSON.parse(out.content[0].text);
    assert.deepEqual(parsed.queries.map((q) => q.query), ["one", "two"]);
    assert.equal(out.details.queries[0].results[0].snippet, undefined);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("web_search rejects query and numResults limits", async () => {
  const searchTool = registerWithFlags({}).find((t) => t.name === "web_search");
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-"));
  await assert.rejects(() => searchTool.execute("id", { queries: ["a", "b", "c", "d", "e", "f"] }, undefined, undefined, { cwd, isProjectTrusted: () => true }), /Too many queries/);
  await assert.rejects(() => searchTool.execute("id", { query: "a", numResults: 21 }, undefined, undefined, { cwd, isProjectTrusted: () => true }), /numResults/);
});

test("web_fetch rejects offset with multiple URLs", async () => {
  const fetchTool = registerWithFlags({}).find((t) => t.name === "web_fetch");
  await assert.rejects(() => fetchTool.execute("id", { urls: ["https://a.test", "https://b.test"], offset: 1 }, undefined, undefined, { cwd: mkdtempSync(join(tmpdir(), "pi-web-kit-")), isProjectTrusted: () => true }), /offset range reads require a single url/);
});

test("web_fetch allows limit with multiple URLs", async () => {
  const fetchTool = registerWithFlags({ "web-provider-fetch": "markdown_new" }).find((t) => t.name === "web_fetch");
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(`content for ${body.url}`, { status: 200, headers: { "content-type": "text/markdown" } });
  };
  try {
    const out = await fetchTool.execute("id", { urls: ["https://limit-a.test", "https://limit-b.test"], limit: 7 }, undefined, undefined, { cwd: mkdtempSync(join(tmpdir(), "pi-web-kit-")), isProjectTrusted: () => true });
    const parsed = JSON.parse(out.content[0].text);
    assert.equal(parsed.results.length, 2);
    assert.deepEqual(parsed.results.map((r) => r.content), ["content", "content"]);
    assert.deepEqual(parsed.results.map((r) => r.range.limit), [7, 7]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("web_fetch rejects invalid range params", async () => {
  const fetchTool = registerWithFlags({ "web-provider-fetch": "markdown_new" }).find((t) => t.name === "web_fetch");
  await assert.rejects(() => fetchTool.execute("id", { url: "https://a.test", offset: 1.5 }, undefined, undefined, { cwd: mkdtempSync(join(tmpdir(), "pi-web-kit-")), isProjectTrusted: () => true }), /offset/);
});

test("single-URL cache hit avoids provider refetch", async () => {
  const config = { provider_search: "exa_mcp", provider_fetch: "markdown_new", apiKeys: {}, markdownNew: { method: "auto", retainImages: false } };
  let calls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(`content-${calls}`, { status: 200, headers: { "content-type": "text/markdown" } });
  };
  try {
    const first = await fetchWithCache("markdown_new", { url: "https://cache.test" }, ["https://cache.test"], undefined, config);
    const second = await fetchWithCache("markdown_new", { url: "https://cache.test" }, ["https://cache.test"], undefined, config);
    assert.equal(calls, 1);
    assert.equal(first.results[0].cached, false);
    assert.equal(second.results[0].cached, true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});


test("large structured fetch output remains valid JSON with continuation metadata", () => {
  const content = "😀line\n".repeat(20_000);
  const out = jsonToolResult({ provider: "test", results: [{ url: "https://e.test", content, range: { offset: 0, limit: 100_000, returned: content.length, total: content.length, truncated: false, hasPrevious: false, hasNext: false } }] });
  assert(Buffer.byteLength(out.content[0].text) <= 50_000);
  const parsed = JSON.parse(out.content[0].text);
  const result = parsed.results[0];
  assert.equal(result.range.returned, result.content.length);
  assert.equal(result.range.hasNext, true);
  assert.equal(result.range.nextOffset, result.content.length);
  assert(!result.content.endsWith("\ud83d"));
});

test("oversized fetch metadata falls back to bounded valid JSON", () => {
  const out = jsonToolResult({
    provider: "test",
    results: [{ url: "https://e.test", title: "x".repeat(60_000), content: "body", range: { offset: 0, returned: 4, total: 4 } }],
  });
  assert(Buffer.byteLength(out.content[0].text) <= 50_000);
  assert.doesNotThrow(() => JSON.parse(out.content[0].text));
});

test("API keys produce opaque distinct cache scopes and never escape results", () => {
  const first = buildCacheKey("exa", "https://e.test", {}, { apiKeys: { exa: "sentinel-prefix-one" } });
  const second = buildCacheKey("exa", "https://e.test", {}, { apiKeys: { exa: "sentinel-prefix-two" } });
  assert.notEqual(first, second);
  assert(!first.includes("sentinel"));
  const out = pageSlice({ provider: "exa", cacheKey: first, url: "https://e.test", content: "body", format: "markdown", fetchedAt: 1 }, 0, 4, false, false);
  assert(!JSON.stringify(out).includes("sentinel"));
  assert.equal(out.cacheKey, undefined);
});

function registerWithFlags(flags, { cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-")), trusted = true } = {}) {
  const tools = [];
  let sessionStart;
  const pi = {
    registerFlag() {},
    getFlag(name) { return flags[name]; },
    registerTool(tool) { tools.push(tool); },
    on(name, handler) { if (name === "session_start") sessionStart = handler; },
  };
  extension(pi);
  sessionStart({}, { cwd, isProjectTrusted: () => trusted });
  return tools;
}
