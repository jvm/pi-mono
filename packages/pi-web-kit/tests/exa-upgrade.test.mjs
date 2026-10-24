import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import extension from "../extensions/index.ts";
import { MAX_CODE_CONTEXT_TOKENS, MAX_OUTPUT_BYTES } from "../src/limits.ts";
import { WEB_OUTPUT_SCHEMAS } from "../src/output.ts";
import { ExaProvider } from "../src/providers/exa.ts";
import { evaluateExa } from "./exa-evaluation.mjs";
import { fetchCache } from "../src/cache.ts";

function harness(t, sink, env = {}) {
  fetchCache.clear();
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-exa-"));
  const saved = { ...process.env };
  process.env.HOME = cwd;
  process.env.EXA_API_KEY = "synthetic-exa-key";
  process.env.CONTEXT7_API_KEY = "synthetic-context-key";
  process.env.PI_TELEMETRY = "0";
  delete process.env.PI_WEB_KIT_PROVIDER_SEARCH;
  delete process.env.PI_WEB_KIT_PROVIDER_FETCH;
  for (const key of ["TINYFISH_API_KEY", "BRAVE_SEARCH_API_KEY", "FIRECRAWL_API_KEY"]) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => {
    fetchCache.clear();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(cwd, { recursive: true, force: true });
  });
  const tools = new Map();
  const events = [];
  let start;
  extension({
    registerFlag() {}, getFlag() {}, registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { if (name === "session_start") start = handler; },
    events: { emit(name, data) { events.push({ name, data }); sink?.(data); } },
  });
  const ctx = { cwd, mode: "print", isProjectTrusted: () => false };
  start({}, ctx);
  return { events, tools, async call(name, args, signal) {
    const out = await tools.get(name).execute("test", args, signal, undefined, ctx);
    assert.ok(Check(WEB_OUTPUT_SCHEMAS[name], out.structuredContent));
    assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
    assert.ok(Buffer.byteLength(out.content[0].text) <= MAX_OUTPUT_BYTES);
    return out;
  } };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test("registered code_search uses fresh Auto and preserves large UTF-8 excerpts with exact omissions", async t => {
  const h = harness(t);
  const response = '界🙂"\\\n'.repeat(20_000);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.exa.ai/search");
    assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body);
    assert.equal(body.type, "auto");
    assert.deepEqual(body.contents, { highlights: true, maxAgeHours: 0, livecrawlTimeout: 15000 });
    assert.equal(body.objective, "Implement version-specific cancellation");
    return json({ results: [{ url: "https://example.test/code", highlights: [response], publishedDate: "2020-01-01" }] });
  });
  for (const contextTokens of [undefined, MAX_CODE_CONTEXT_TOKENS, 50, 1]) {
    const out = await h.call("code_search", { query: "Node 22 fetch cancellation", purpose: "Implement version-specific cancellation",
      ...(contextTokens == null ? {} : { contextTokens }) });
    const data = out.structuredContent;
    const content = data.results[0].content;
    if (contextTokens == null || contextTokens === MAX_CODE_CONTEXT_TOKENS) assert.ok(content.length > 10_000);
    assert.ok(response.startsWith(content));
    assert.equal(data.omittedContextCharacters + data.contextCharacters, response.length);
    assert.equal(data.effectiveContextTokens, contextTokens ?? MAX_CODE_CONTEXT_TOKENS);
    assert.equal(data.contextCharacters, content.length);
    assert.equal(data.results[0].publishedDate, "2020-01-01", "evergreen docs must not be dropped by publication age");
    assert.equal(out.details.results[0].content, undefined);
    assert.ok(content.isWellFormed());
  }
  assert.ok(h.events.every(e => e.name === "pi-web-kit:exa-diagnostics" && e.data.endpoint === "/search"));
});

test("small code results and credential masking retain exact character accounting", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async () => json({ results: [{ url: "https://example.test", highlights: ["synthetic-exa-key example"] }] }));
  const out = await h.call("code_search", { query: "q", purpose: "Implement q", contextTokens: 100 });
  assert.equal(out.structuredContent.omittedContextCharacters, 0);
  assert.equal(out.structuredContent.contextCharacters, "synthetic-exa-key example".length);
  assert.doesNotMatch(JSON.stringify(out), /synthetic-exa-key/);
});

test("registered search wires highlights, objective, bounded notices and non-model diagnostics across queries", async t => {
  const h = harness(t);
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    assert.deepEqual(body.contents, { highlights: true });
    assert.equal(body.objective, "Prefer implementation sources");
    assert.equal(body.type, "auto");
    assert.equal(init.headers["Exa-Beta"], undefined, "beta must not be silently enabled");
    return json({
      requestId: "fixture-request", searchTime: 7, costDollars: { total: 0.007, private: "private-cost" },
      warnings: [{ code: "IGNORED_FIELD", path: "/oldOption", message: "private-warning-query synthetic-exa-key", details: "private-warning" }],
      notices: Array.from({ length: 20 }, (_, i) => ({
        code: i ? "FUTURE_NOTICE" : "RESTRICTIONS_RELAXED", path: "/query",
        message: `synthetic-exa-key synthetic-context-key Authorization: Bearer abc ${"n".repeat(1000)}`,
        details: { private: "private-notice" },
      })),
      results: [{ url: "https://example.test", highlights: ["relevant evidence ".repeat(500)], text: "irrelevant text" }],
    });
  });
  const out = await h.call("web_search", { queries: ["one", "two"], contextTokens: 100, purpose: "Prefer implementation sources" });
  assert.equal(bodies.length, 2);
  for (const group of out.structuredContent.queries) {
    assert.equal(group.contextCharacters, 400);
    assert.ok(group.results[0].content.startsWith("relevant evidence"));
    assert.equal(group.notices.length, 8);
    assert.equal(group.omittedNoticeCount, 12);
    assert.equal(group.notices[1].code, "FUTURE_NOTICE");
    assert.ok(group.notices.every(n => n.message.length <= 512));
    assert.equal(group.warnings, undefined);
  }
  assert.doesNotMatch(JSON.stringify(out), /private-|synthetic-exa-key|synthetic-context-key|Bearer abc|irrelevant text/);
  assert.equal(h.events.length, 2);
  for (const { name, data } of h.events) {
    assert.equal(name, "pi-web-kit:exa-diagnostics");
    assert.equal(data.requestId, "fixture-request");
    assert.equal(data.costDollars, 0.007);
    assert.equal(data.searchTime, 7);
    assert.ok(data.durationMs >= 0);
    assert.deepEqual(data.warnings, [{ code: "IGNORED_FIELD", path: "/oldOption" }]);
    assert.doesNotMatch(JSON.stringify(data), /private-|one|two|Prefer|synthetic|relevant evidence/);
  }
});

test("Lite accepts supported filters and rejects incompatible options before a request", async t => {
  const h = harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.type, "lite");
    assert.deepEqual(body.contents, { highlights: true });
    assert.deepEqual(body.includeDomains, ["github.com/org/repo"]);
    assert.equal(body.startPublishedDate, "2026-01-01");
    return json({ results: [] });
  });
  await h.call("web_search", { query: "q", purpose: "Find implementation sources", type: "lite", includeDomains: ["github.com/org/repo"], startPublishedDate: "2026-01-01" });
  for (const maxAgeHours of [-1, 0, 1, 24]) {
    await assert.rejects(h.call("web_search", { query: "q", purpose: "Find sources", type: "lite", maxAgeHours }), /lite does not support maxAgeHours/);
  }
  for (const field of ["startCrawlDate", "endCrawlDate"]) {
    for (const type of ["auto", "lite"]) {
      await assert.rejects(h.call("web_search", { query: "q", purpose: "Find sources", type, [field]: "2026-01-01" }), /Exa ignores/);
    }
    assert.match(h.tools.get("web_search").parameters.properties[field].description, /Deprecated/);
  }
  for (const input of [{ category: "people", excludeDomains: [] }, { category: "company", startPublishedDate: "2026-01-01" },
    { purpose: "x".repeat(2001) }, { includeDomains: [1] }, { maxAgeHours: 0.5 }, { startPublishedDate: "not-a-date" },
    { type: "lite", contents: { summary: true } }, { type: "lite", outputSchema: {} }]) {
    await assert.rejects(h.call("web_search", { query: "q", purpose: "Find sources", ...input }));
  }
  assert.equal(calls, 1);
});

test("Auto retains freshness controls and explicit legacy search modes", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.type, "fast");
    assert.deepEqual(body.contents, { highlights: true, maxAgeHours: 0 });
    return json({ results: [{ url: "https://example.test", highlights: [], text: "fallback evidence" }] });
  });
  const result = await h.call("web_search", { query: "q", purpose: "Find sources", type: "fast", maxAgeHours: 0 });
  assert.equal(result.structuredContent.queries[0].results[0].content, "fallback evidence");
});

test("diagnostic input is allowlisted, bounded and cannot interrupt successful calls", async t => {
  const h = harness(t, () => { throw new Error("sink failure"); });
  t.mock.method(globalThis, "fetch", async () => json({
    results: [], requestId: "synthetic-exa-key", searchTime: -2, costDollars: { total: "private" },
    warnings: Array.from({ length: 100 }, () => ({ code: "FUTURE_WARNING", path: "/query?secret=value", message: "private" })),
    notices: [null, { code: 123, message: "bad" }],
  }));
  await h.call("web_search", { query: "private query", purpose: "Find sources", type: "future-mode-private" });
  const data = h.events[0].data;
  assert.equal(data.requestId, undefined);
  assert.equal(data.searchType, undefined);
  assert.equal(data.searchTime, undefined);
  assert.equal(data.costDollars, undefined);
  assert.equal(data.warnings.length, 8);
  assert.equal(data.omittedWarningCount, 92);
  assert.doesNotMatch(JSON.stringify(data), /private|secret|synthetic/);
});

test("diagnostics for HTTP failures and cancellation never echo raw bodies or abort reasons", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async () => new Response("private-backend-body", { status: 429 }));
  await assert.rejects(h.call("web_search", { query: "private-query", purpose: "Find sources" }), /HTTP 429/);
  assert.equal(h.events[0].data.error, "http");
  assert.equal(h.events[0].data.httpStatus, 429);
  const controller = new AbortController();
  globalThis.fetch = async () => { controller.abort("private-abort"); return json({ results: [] }); };
  await assert.rejects(h.call("web_search", { query: "q", purpose: "Find sources" }, controller.signal));
  assert.equal(h.events[1].data.error, "cancelled");
  assert.doesNotMatch(JSON.stringify(h.events), /private-/);
});

test("direct provider rejects invalid code budgets before network access", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("network must not run"); });
  const provider = new ExaProvider({ apiKeys: { exa: "synthetic" } });
  for (const contextTokens of [0, -1, MAX_CODE_CONTEXT_TOKENS + 1, 1.5, Infinity, "large"]) {
    await assert.rejects(provider.searchCode({ query: "q", purpose: "Implement q", contextTokens }), /contextTokens/);
  }
});

test("manual evaluation separates beta requests, bounds results and never retries failures", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, beta: init.headers["Exa-Beta"] });
    assert.equal(init.redirect, "error");
    if (requests.length === 1) return new Response("private failure", { status: 429 });
    assert.equal(url, "https://api.exa.ai/search");
    assert.equal(body.numResults, 5);
    assert.equal(typeof body.objective, "string");
    if (init.headers["Exa-Beta"]) {
      assert.equal(init.headers["Exa-Beta"], "dynamic-highlights-2026-08-28");
      assert.deepEqual(body.contents.highlights, { dynamic: true });
      assert.equal(body.type, "auto");
    } else assert.deepEqual(body.contents.highlights, true);
    if (body.contents.maxAgeHours != null) assert.equal(body.contents.maxAgeHours, 0);
    return json({ costDollars: { total: 0.004 }, results: Array.from({ length: 5 }, () => ({
      url: "https://example.test", highlights: ["synthetic-key " + "example ".repeat(10_000)],
    })) });
  });
  const rows = await evaluateExa("synthetic-key");
  assert.equal(requests.length, 12);
  assert.equal(requests.filter(r => r.beta).length, 3);
  assert.equal(rows.filter(r => !r.ok).length, 1);
  assert.ok(rows.filter(r => r.ok).every(r => r.jsonBytes <= MAX_OUTPUT_BYTES));
  assert.ok(rows.filter(r => r.ok).every(r => r.returnedCharacters <= 8004));
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-key|private failure/);
});

test("manual evaluation masks credentials before a provider over-return splits them at the context boundary", async t => {
  t.mock.method(globalThis, "fetch", async () => json({
    results: Array.from({ length: 20 }, (_, i) => ({
      url: `https://example.test/${i}`, highlights: ["x".repeat(394) + "synthetic-key tail"],
    })),
  }));
  const rows = await evaluateExa("synthetic-key");
  assert.equal(rows.length, 12);
  assert.ok(rows.every(row => row.ok));
  assert.ok(rows.filter(row => row.mode === "dynamic").every(row => row.sources.length === 20));
  for (const row of rows) {
    for (const source of row.sources) assert.doesNotMatch(source.excerpt, /synthe/, `${row.case}/${row.mode}`);
  }
});

for (const withStatuses of [true, false]) {
  test(`registered fetch never reuses another URL's content after a partial failure (statuses=${withStatuses})`, async t => {
    const h = harness(t);
    const a = "https://a.example.test/";
    const b = "https://b.example.test/";
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      calls.push(url);
      if (url === "https://api.exa.ai/contents") return json({
        results: [{ id: b, url: b, text: "CONTENT FOR B" }],
        ...(withStatuses ? { statuses: [
          { id: a, status: "error", error: { tag: "private-error", httpStatusCode: 404 } },
          { id: b, status: "success" },
        ] } : {}),
      });
      assert.equal(url, "https://markdown.new/");
      assert.equal(JSON.parse(init.body).url, a);
      return new Response("FALLBACK FOR A");
    });
    const input = { urls: [a, b] };
    const out = (await h.call("web_fetch", input)).structuredContent;
    assert.equal(out.results[0].url, a);
    assert.equal(out.results[0].content, "FALLBACK FOR A");
    assert.equal(out.results[1].content, "CONTENT FOR B");
    assert.doesNotMatch(JSON.stringify(out), /private-error/);
    const cached = (await h.call("web_fetch", input)).structuredContent;
    assert.ok(cached.results.every(r => r.cached));
    assert.deepEqual(cached.results.map(r => r.content), ["FALLBACK FOR A", "CONTENT FOR B"]);
    assert.equal(calls.length, 2, "one Exa call and one fallback; cached reads must not refetch");
  });
}

test("registered fetch preserves requested identities when redirected and exact URLs collide", async t => {
  const h = harness(t);
  const a = "https://a.example.test/";
  const b = "https://b.example.test/";
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://api.exa.ai/contents");
    return json({
      results: [{ id: b, url: b, text: "ORIGINAL B" }, { id: a, url: b, text: "REDIRECTED A" }],
      statuses: [{ id: b, status: "success" }, { id: a, status: "success" }],
    });
  });
  const result = (await h.call("web_fetch", { urls: [a, b] })).structuredContent;
  assert.deepEqual(result.results.map(r => r.content), ["REDIRECTED A", "ORIGINAL B"]);
  assert.deepEqual(result.results.map(r => r.fetchedUrl), [b, b]);
  assert.deepEqual(result.results.map(r => r.url), [a, b]);
});

test("failed fetch status overrides returned content and failed fallback is never cached", async t => {
  const h = harness(t);
  const url = "https://failed.example.test/";
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async destination => {
    if (destination !== "https://api.exa.ai/contents") throw new Error("fallback unavailable");
    attempts++;
    return json({
      results: [{ id: url, url, text: "UNUSABLE RESULT" }],
      statuses: [{ id: url, status: "error", error: { tag: "SOURCE_NOT_AVAILABLE" } }],
    });
  });
  for (let i = 0; i < 2; i++) {
    const result = (await h.call("web_fetch", { url })).structuredContent.results[0];
    assert.equal(typeof result.error, "string");
    assert.equal(result.content, undefined);
  }
  assert.equal(attempts, 2);
});

test("registered fetch does not guess redirect identities in a partial batch", async t => {
  const h = harness(t);
  const urls = ["https://a.example.test/", "https://b.example.test/", "https://c.example.test/"];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === "https://api.exa.ai/contents") return json({
      results: [{ id: "https://redirect.example.test/", url: "https://redirect.example.test/", text: "UNIDENTIFIABLE CONTENT" }],
      statuses: urls.map((id, i) => ({ id, status: i ? "success" : "error" })),
    });
    assert.equal(url, "https://markdown.new/");
    return new Response(`Fallback for ${JSON.parse(init.body).url}`);
  });
  const out = (await h.call("web_fetch", { urls })).structuredContent;
  assert.deepEqual(out.results.map(r => r.content), urls.map(url => `Fallback for ${url}`));
  assert.doesNotMatch(JSON.stringify(out), /UNIDENTIFIABLE CONTENT/);
});

test("registered search and fetch enforce the Exa freshness range and cap millisecond conversion", async t => {
  const h = harness(t);
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return json({ results: url.endsWith("/contents") ? [{ url: body.urls[0], text: "fresh" }] : [] });
  });
  for (const maxAgeHours of [-1, 0, 720]) {
    await h.call("web_search", { query: "q", purpose: "Find sources", maxAgeHours });
    assert.equal(bodies.at(-1).contents.maxAgeHours, maxAgeHours);
    await h.call("web_fetch", { url: `https://freshness.test/${maxAgeHours}`, maxAgeHours });
    assert.equal(bodies.at(-1).maxAgeHours, maxAgeHours);
  }
  for (const maxAgeHours of [-2, 721, 0.5, Number.MAX_VALUE]) {
    assert.equal(Check(h.tools.get("web_search").parameters, { query: "q", purpose: "Find sources", maxAgeHours }), false);
    assert.equal(Check(h.tools.get("web_fetch").parameters, { url: "https://freshness.test", maxAgeHours }), false);
    await assert.rejects(h.call("web_search", { query: "q", purpose: "Find sources", maxAgeHours }), /maxAgeHours/);
    await assert.rejects(h.call("web_fetch", { url: "https://freshness.test", maxAgeHours }), /maxAgeHours/);
  }
  assert.equal(bodies.length, 6, "invalid freshness must fail before provider calls");
  for (const [maxAgeMs, expected] of [[0, 0], [5_400_000, 1], [720 * 3_600_000, 720], [31 * 24 * 3_600_000, 720]]) {
    await h.call("web_fetch", { url: "https://ms-freshness.test", maxAgeMs });
    assert.equal(bodies.at(-1).maxAgeHours, expected);
  }
  await assert.rejects(h.call("web_fetch", { url: "https://refresh.test", maxAgeHours: 721, refresh: true }), /maxAgeHours/);
});

test("registered Exa search advertises and enforces its local string and array limits", async t => {
  const h = harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ results: [] }); });
  const schema = h.tools.get("web_search").parameters;
  const valid = { query: "q".repeat(2000), category: "c".repeat(64), type: "t".repeat(64),
    purpose: "p".repeat(2000), includeDomains: Array(1200).fill("d".repeat(2048)),
    startPublishedDate: "2026-01-01" };
  assert.equal(Check(schema, valid), true);
  await h.call("web_search", valid);
  assert.equal(calls, 1);
  for (const input of [
    { query: "q".repeat(2001) }, { queries: ["q".repeat(2001)] },
    { category: "c".repeat(65) }, { type: "t".repeat(65) }, { purpose: "p".repeat(2001) },
    { includeDomains: Array(1201).fill("example.com") }, { excludeDomains: ["d".repeat(2049)] },
    { includeDomains: [""] }, { excludeDomains: [" "] }, { category: " " }, { type: " " }, { purpose: " " },
    { startPublishedDate: "x".repeat(129) }, { endPublishedDate: "not-a-date" },
  ]) {
    const args = { query: "q", purpose: "Find sources", ...input };
    assert.equal(Check(schema, args), false, JSON.stringify(input).slice(0, 100));
    await assert.rejects(h.call("web_search", args));
  }
  assert.equal(calls, 1);
});

test("code freshness cannot inherit any search/fetch provider configuration", async t => {
  for (const search of ["exa", "tinyfish", "brave", "firecrawl"]) {
    for (const fetch of ["exa", "tinyfish", "markdown_new", "firecrawl"]) {
      await t.test(`${search}/${fetch}`, async child => {
        const h = harness(child, undefined, { PI_WEB_KIT_PROVIDER_SEARCH: search, PI_WEB_KIT_PROVIDER_FETCH: fetch,
          TINYFISH_API_KEY: "synthetic-tiny", BRAVE_SEARCH_API_KEY: "synthetic-brave", FIRECRAWL_API_KEY: "synthetic-fire" });
        let calls = 0;
        child.mock.method(globalThis, "fetch", async (url, init) => {
          calls++;
          assert.equal(url, "https://api.exa.ai/search", "no Agent, legacy endpoint, or other provider");
          const body = JSON.parse(init.body);
          assert.equal(body.type, "auto");
          assert.equal(body.numResults, 5);
          assert.equal(body.objective, "Deep research is mentioned here, but this is still ordinary retrieval");
          assert.deepEqual(body.contents, { highlights: true, maxAgeHours: 0, livecrawlTimeout: 15000 });
          assert.equal(init.headers["Exa-Beta"], undefined);
          assert.equal(init.headers["x-api-key"], "synthetic-exa-key");
          assert.equal(body.outputSchema, undefined);
          assert.equal(body.systemPrompt, undefined);
          assert.equal(body.startPublishedDate, undefined, "do not exclude evergreen reference docs");
          return json({ results: [{ url: "https://fixture.test/code", highlights: ["live evidence"], publishedDate: "2018-01-01" }] });
        });
        const result = (await h.call("code_search", { query: "Node.js 22 pipeline AbortSignal",
          purpose: "Deep research is mentioned here, but this is still ordinary retrieval" })).structuredContent;
        assert.equal(result.results[0].content, "live evidence");
        assert.equal(result.searchType, "auto");
        assert.equal(result.maxAgeHours, 0);
        assert.equal(calls, 1, "purpose is not a second request or an Agent run");
      });
    }
  }
});

test("registered code search rejects every mode/cache/research override, including null and legacy controls", async t => {
  const h = harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not run"); });
  const schema = h.tools.get("code_search").parameters;
  for (const [key, values] of Object.entries({
    type: ["lite", "instant", "fast", "deep-lite", "deep", "deep-reasoning", "auto", null],
    maxAgeHours: [-1, 0, 24, 720, null], maxAgeMs: [0, 3600000], livecrawl: ["never", "always"],
    snapshotAsOf: ["2026-01-01"], contents: [{ highlights: true }, { maxAgeHours: -1 }, { summary: true }],
    outputSchema: [{}], systemPrompt: ["Do research"], effort: ["high"], stream: [true],
    tokensNum: ["dynamic", 8192], additionalQueries: [["q"]], category: ["github"],
    startPublishedDate: ["2026-01-01"], endCrawlDate: ["2026-01-01"],
  })) {
    for (const value of values) {
      const args = { query: "q", purpose: "Implement q", [key]: value };
      assert.equal(Check(schema, args), false, key);
      await assert.rejects(h.call("code_search", args), /Unsupported code_search parameter/);
    }
  }
  assert.equal(calls, 0);
});

test("purpose is required for ordinary Exa Search and code search, but not for other search providers", async t => {
  const h = harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ results: [] }); });
  for (const name of ["web_search", "code_search"]) {
    const schema = h.tools.get(name).parameters;
    for (const value of [undefined, null, "", " \t\n", "x".repeat(2001)]) {
      const args = { query: "q", ...(value === undefined ? {} : { purpose: value }) };
      assert.equal(Check(schema, args), false);
      await assert.rejects(h.call(name, args), /purpose/);
    }
    await h.call(name, { query: "q", purpose: "Implement q" });
  }
  for (const provider of ["brave", "tinyfish", "firecrawl"]) {
    const { buildSearchSchema } = await import("../extensions/index.ts");
    assert.equal(Check(buildSearchSchema(provider), { query: "q" }), true);
  }
  assert.equal(calls, 2);
});

test("code search validates all budget boundaries and never accepts surcharge-sized breadth", async t => {
  const h = harness(t);
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return json({ results: Array.from({ length: body.numResults + 2 }, (_, i) => ({
      url: `https://source.test/${i}`, highlights: ["example ".repeat(1000)],
    })) });
  });
  const schema = h.tools.get("code_search").parameters;
  for (const numResults of [1, 5, 10]) for (const contextTokens of [1, 50, MAX_CODE_CONTEXT_TOKENS]) {
    const args = { query: "q", purpose: "Implement q", numResults, contextTokens,
      includeDomains: ["github.com/org/repo"], excludeDomains: ["outdated.test/docs"] };
    assert.equal(Check(schema, args), true);
    const result = (await h.call("code_search", args)).structuredContent;
    assert.equal(result.resultCount, numResults);
    assert.equal(result.omittedResultCount, 2);
    assert.ok(result.contextCharacters <= contextTokens * 4);
    assert.equal(result.contextCharacters + result.omittedContextCharacters, (numResults + 2) * 8000);
    assert.ok(result.results.every(r => r.snippet == null), "duplicate snippets must not evade the context budget");
    assert.equal(result.effectiveContextTokens, contextTokens);
    assert.equal(bodies.at(-1).numResults, numResults);
    assert.deepEqual(bodies.at(-1).includeDomains, args.includeDomains);
    assert.deepEqual(bodies.at(-1).excludeDomains, args.excludeDomains);
  }
  for (const input of [
    { numResults: 0 }, { numResults: 11 }, { numResults: 100 }, { numResults: 1.5 },
    { contextTokens: 0 }, { contextTokens: 8193 }, { contextTokens: Infinity }, { contextTokens: "dynamic" },
    { query: "q".repeat(2001) }, { includeDomains: [" "] }, { excludeDomains: ["x".repeat(2049)] },
    { includeDomains: Array(1201).fill("example.test") },
  ]) {
    const args = { query: "q", purpose: "Implement q", ...input };
    assert.equal(Check(schema, args), false);
    await assert.rejects(h.call("code_search", args));
  }
  assert.equal(bodies.length, 9);
});

test("code search drops metadata-only and stale text/summary fallbacks, and never caches searches", async t => {
  const h = harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://api.exa.ai/search");
    calls++;
    return json({ output: { content: "UNREQUESTED SYNTHESIS" }, results: [
      { url: "https://source.test/live", title: "Live", highlights: [`revision ${calls}`], text: "STALE TEXT" },
      { url: "https://source.test/cached", highlights: [], text: "CACHED TEXT" },
      { url: "https://source.test/summary", highlights: [" "], summary: "CACHED SUMMARY" },
      { url: "https://source.test/no-content" },
    ], notices: [{ code: "FUTURE_NOTICE", message: "Provider notice", path: "/query", details: { private: "private" } }],
    warnings: [{ code: "IGNORED_FIELD", path: "/old", message: "PRIVATE WARNING" }] });
  });
  for (const revision of [1, 2]) {
    const out = (await h.call("code_search", { query: "q", purpose: "Implement q" })).structuredContent;
    assert.equal(out.resultCount, 1);
    assert.equal(out.omittedNoContentCount, 3);
    assert.equal(out.results[0].content, `revision ${revision}`);
    assert.equal(out.notices[0].code, "FUTURE_NOTICE");
    assert.doesNotMatch(JSON.stringify(out), /CACHED|STALE|SYNTHESIS|PRIVATE|private/);
  }
  assert.equal(calls, 2);
});

test("code search errors never retry or downgrade to cached retrieval", async t => {
  const h = harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async url => { assert.equal(url, "https://api.exa.ai/search"); calls++; return json({ error: "private" }, status); });
  let status;
  for (status of [400, 401, 402, 403, 429, 500, 503, 504]) {
    await assert.rejects(h.call("code_search", { query: "q", purpose: "Implement q" }), new RegExp(`HTTP ${status}`));
  }
  for (const invalid of [{}, null, [], { results: "bad" }]) {
    globalThis.fetch = async () => { calls++; return json(invalid); };
    await assert.rejects(h.call("code_search", { query: "q", purpose: "Implement q" }), /invalid JSON/);
  }
  assert.equal(calls, 12);
  assert.ok(h.events.every(e => e.data.error));
});

test("all documented general-search modes keep objective separate from freshness and synthesis", async t => {
  const h = harness(t);
  let calls = 0;
  let expectedBody;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(url, "https://api.exa.ai/search");
    const body = JSON.parse(init.body);
    assert.equal(body.type, expectedBody.type);
    assert.equal(body.contents.maxAgeHours, expectedBody.maxAgeHours);
    assert.equal(body.objective, "Find ordinary evidence");
    assert.equal(body.outputSchema, undefined);
    assert.equal(body.systemPrompt, undefined);
    assert.equal(body.stream, undefined);
    return json({ results: [] });
  });
  let expected = 0;
  for (const type of ["auto", "lite", "deep-lite", "deep", "instant", "fast", "deep-reasoning"]) {
    for (const maxAgeHours of [undefined, -1, 0, 24, 720]) {
      const args = { query: "q", purpose: "Find ordinary evidence", type, ...(maxAgeHours == null ? {} : { maxAgeHours }) };
      expectedBody = { type, maxAgeHours };
      if (type === "lite" && maxAgeHours != null) await assert.rejects(h.call("web_search", args), /lite does not support/);
      else { await h.call("web_search", args); expected++; }
    }
  }
  assert.equal(calls, expected);
});

test("fresh code search deadline covers body stalls after headers", async t => {
  const h = harness(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
      pull() { entered(); },
    }));
  });
  const pending = h.call("code_search", { query: "q", purpose: "Implement q" });
  await started;
  const rejected = assert.rejects(pending, /Request timed out after 45000ms/);
  t.mock.timers.tick(45000);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(h.events[0].data.error, "timeout");
});

test("code search cancellation before a request and after headers never yields a success snapshot", async t => {
  const h = harness(t);
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error("private-abort"));
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ results: [] }); });
  await assert.rejects(h.call("code_search", { query: "q", purpose: "Implement q" }, controller.signal), /Web tool cancelled/);
  assert.equal(calls, 0);
  const afterHeaders = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  globalThis.fetch = async (_url, init) => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
      },
      pull() { entered(); },
    }));
  };
  const pending = h.call("code_search", { query: "q", purpose: "Implement q" }, afterHeaders.signal);
  await started;
  const rejected = assert.rejects(pending, /Web tool cancelled/);
  afterHeaders.abort(new Error("private-abort"));
  await rejected;
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(h.events), /private-abort/);
});

test("registered research tools mask credentials before context budgets and cached range slicing", async t => {
  const h = harness(t);
  const text = "prefix synthetic-exa-key suffix";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return json({ results: [{ id: "https://redaction.test/", url: "https://redaction.test/", text, highlights: [text] }] });
  });
  for (const name of ["web_search", "code_search"]) {
    const result = (await h.call(name, { query: "q", purpose: "Implement q", contextTokens: 5 })).structuredContent;
    const source = name === "web_search" ? result.queries[0].results[0] : result.results[0];
    assert.equal(source.content, "prefix *************", `${name} must not reveal a credential prefix`);
  }
  for (const offset of [0, 7, 10]) {
    const result = (await h.call("web_fetch", { url: "https://redaction.test/", offset, limit: 20 })).structuredContent.results[0];
    assert.equal(result.content, "prefix ***************** suffix".slice(offset, offset + 20));
    assert.equal(result.range.total, text.length, "masking must preserve range offsets");
    assert.doesNotMatch(result.content, /synthet|exa-key/);
    if (offset) assert.equal(result.cached, true);
  }
  assert.equal(calls, 3, "range reads should use the same safely masked cache page");
});

test("all search providers mask cross-provider credentials before the snippet cut", async t => {
  for (const provider of ["exa", "tinyfish", "brave", "firecrawl"]) {
    await t.test(provider, async child => {
      const h = harness(child, undefined, { PI_WEB_KIT_PROVIDER_SEARCH: provider,
        TINYFISH_API_KEY: "synthetic-tiny", BRAVE_SEARCH_API_KEY: "synthetic-brave", FIRECRAWL_API_KEY: "synthetic-fire" });
      const text = "x".repeat(994) + "synthetic-context-key suffix";
      child.mock.method(globalThis, "fetch", async () => {
        const row = { url: "https://redaction.test/", title: "T", highlights: [text], snippet: text, snippets: [text], markdown: text };
        return json({ results: [row], total_results: 1, grounding: { generic: [row] }, data: { web: [row] } });
      });
      const result = (await h.call("web_search", { query: "q", purpose: "Find sources" })).structuredContent;
      const snippet = result.queries[0].results[0].snippet;
      assert.equal(snippet, "x".repeat(994) + "******");
      assert.doesNotMatch(JSON.stringify(result), /synthetic-context-key/);
    });
  }
});
