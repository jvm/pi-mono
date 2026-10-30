import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import extension from "../extensions/index.ts";
import { fetchCache } from "../src/cache.ts";
import { WEB_OUTPUT_SCHEMAS } from "../src/output.ts";
import { FetchCache } from "../src/cache.ts";
import { MAX_RESPONSE_BYTES } from "../src/limits.ts";
import { ProviderRequestError, requestJson } from "../src/http.ts";
import { createServer } from "node:http";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const a = "https://a.test/page";
const b = "https://b.test/page";

function harness(t, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-web-kit-hardening-"));
  const saved = { ...process.env };
  for (const name of ["PI_WEB_KIT_PROVIDER_SEARCH", "PI_WEB_KIT_PROVIDER_FETCH",
    "EXA_API_KEY", "TINYFISH_API_KEY", "BRAVE_SEARCH_API_KEY", "FIRECRAWL_API_KEY", "CONTEXT7_API_KEY"]) delete process.env[name];
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"),
    PI_TELEMETRY: "0", EXA_API_KEY: "synthetic-exa", CONTEXT7_API_KEY: "synthetic-context", ...env });
  fetchCache.clear();
  t.after(() => {
    fetchCache.clear();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(home, { recursive: true, force: true });
  });
  const tools = new Map();
  let start;
  extension({
    registerFlag() {}, getFlag() {}, registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { if (name === "session_start") start = handler; },
  });
  const ctx = { cwd: home, mode: "print", isProjectTrusted: () => false };
  const reload = () => start({}, ctx);
  reload();
  return { home, tools, reload, async call(name, args, signal, onUpdate) {
    assert.ok(Check(tools.get(name).parameters, args), "regression inputs must pass the registered schema");
    const result = await tools.get(name).execute("test", args, signal, onUpdate, ctx);
    assert.ok(Check(WEB_OUTPUT_SCHEMAS[name], result.structuredContent));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 50_000);
    return result;
  } };
}

for (const failure of ["invalid JSON", "invalid shape", "advertised size", "streamed size", "cancellation"]) {
  test(`registered search keeps ${failure} fatal after earlier success`, async t => {
    const h = harness(t);
    const cancellation = new AbortController();
    const queries = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      const { query } = JSON.parse(init.body);
      queries.push(query);
      if (query !== "fail") return json({ results: [{ url: a, title: query, highlights: [query] }] });
      if (failure === "invalid JSON") return new Response("private invalid JSON");
      if (failure === "invalid shape") return json({ results: null });
      if (failure === "advertised size") return new Response("", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } });
      let reads = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (failure === "streamed size") {
            controller.enqueue(new Uint8Array(1024 * 1024));
          } else if (reads++ === 0) {
            controller.enqueue(new TextEncoder().encode('{"private":"partial'));
          } else {
            cancellation.abort(new Error("private abort reason"));
            controller.error(cancellation.signal.reason);
          }
        },
      }));
    });
    const expected = failure === "cancellation" ? "Web tool cancelled."
      : failure.includes("size") ? `Provider response exceeded ${MAX_RESPONSE_BYTES} bytes.`
      : "Provider returned invalid JSON.";
    await assert.rejects(h.call("web_search", { queries: ["first", "fail", "last"], purpose: "Find evidence" }, cancellation.signal),
      error => !(error instanceof ProviderRequestError) && error.message === expected);
    assert.deepEqual(queries, ["first", "fail"], "fatal errors must not publish a partial result or dispatch later queries");
  });
}

test("native response-body disconnects are bounded operational failures", { timeout: 10_000 }, async t => {
  const nativeFetch = globalThis.fetch;
  let response;
  let receivedHeaders = false;
  const server = createServer((_req, res) => {
    response = res;
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"private":"partial');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.mock.method(globalThis, "fetch", async (...args) => {
    const res = await nativeFetch(...args);
    receivedHeaders = true;
    setImmediate(() => response.destroy());
    return res;
  });
  try {
    await assert.rejects(requestJson(`http://127.0.0.1:${server.address().port}/disconnect`, { timeoutMs: 5000 }),
      error => error instanceof ProviderRequestError && error.message === "Provider response body could not be read.");
    assert.equal(receivedHeaders, true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const provider of ["tinyfish", "firecrawl"]) {
  test(`${provider}: registered fetch keeps redirect collisions and failures attached through caching`, async t => {
    const h = harness(t, { PI_WEB_KIT_PROVIDER_FETCH: provider,
      TINYFISH_API_KEY: "synthetic-tinyfish", FIRECRAWL_API_KEY: "synthetic-firecrawl" });
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (provider === "tinyfish") return json({
        results: body.urls.some(url => url === a) ? [{ url: a, final_url: b, text: "body from A" }] : [],
        errors: [{ url: b, error: "page_not_found" }],
      });
      return body.url === a ? json({ data: { url: b, markdown: "body from A" } }) : json({}, 404);
    });
    for (const cached of [false, true]) {
      const { results } = (await h.call("web_fetch", { urls: [a, b] })).structuredContent;
      assert.equal(results[0].url, a);
      assert.equal(results[0].fetchedUrl, b);
      assert.equal(results[0].content, "body from A");
      assert.equal(results[0].cached, cached);
      assert.equal(results[1].url, b);
      assert.ok(results[1].error);
      assert.equal(results[1].content, undefined);
    }
    assert.equal(requests.filter(body => body.url === a || body.urls?.some(url => url === a)).length, 1);
  });
}

test("registered TinyFish search preserves one-sided and reversed date/year bounds", async t => {
  const h = harness(t, { PI_WEB_KIT_PROVIDER_SEARCH: "tinyfish", TINYFISH_API_KEY: "synthetic-tinyfish" });
  const cases = [
    [{ beforeDate: "2020-01-01" }, { before_date: "2020-01-01" }],
    [{ afterDate: "2020-01-01" }, { after_date: "2020-01-01" }],
    [{ domainType: "research_paper", pubYearMax: 2020 }, { pub_year_max: "2020" }],
    [{ domainType: "research_paper", pubYearMin: 2020 }, { pub_year_min: "2020" }],
    [{ beforeDate: "2020-01-01", afterDate: "2025-01-01" }, { after_date: "2020-01-01", before_date: "2025-01-01" }],
    [{ domainType: "research_paper", pubYearMin: 2025, pubYearMax: 2020 }, { pub_year_min: "2020", pub_year_max: "2025" }],
  ];
  let expected;
  t.mock.method(globalThis, "fetch", async url => {
    const params = new URL(url).searchParams;
    for (const key of ["after_date", "before_date", "pub_year_min", "pub_year_max"]) {
      assert.equal(params.get(key), expected[key] ?? null);
    }
    return json({ results: [] });
  });
  for (const [input, bounds] of cases) {
    expected = bounds;
    await h.call("web_search", { query: "historical research", ...input });
  }
});

for (const provider of ["markdown_new", "exa"]) {
  test(`registered ${provider} markdown path deadline covers a stalled body after headers`, async t => {
    const h = harness(t, { PI_WEB_KIT_PROVIDER_FETCH: provider });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let signal;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      if (_url.includes("exa.ai")) return json({ results: [] });
      signal = init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        },
        pull() { entered(); },
      }));
    });
    const pending = h.call("web_fetch", { url: a });
    await started;
    // Let the response headers reach the provider before advancing the deadline.
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(45_000);
    assert.equal(signal.aborted, true);
    const { results } = (await pending).structuredContent;
    // Exa keeps the primary controlled error when all fallback attempts fail.
    assert.match(results[0].error, provider === "exa" ? /No content returned by Exa/ : /timed out/);
    assert.equal(results[0].content, undefined);
    assert.equal(fetchCache.size, 0);
  });
}

test("registered search and fetch keep complete long URLs when output exceeds 50KB", async t => {
  const h = harness(t, { PI_WEB_KIT_PROVIDER_FETCH: "markdown_new" });
  const urls = Array.from({ length: 5 }, (_, i) => `https://example.test/${i}/${"x".repeat(1400)}`);
  t.mock.method(globalThis, "fetch", async url => url.includes("exa.ai")
    ? json({ results: urls.map(url => ({ url, highlights: ["a".repeat(8000)] })) })
    : new Response("a".repeat(60_000)));
  const search = (await h.call("web_search", {
    query: "q", purpose: "research q", contextTokens: 10_000, numResults: 5,
  })).structuredContent;
  assert.deepEqual(search.queries[0].results.map(r => r.url), urls);
  const page = (await h.call("web_fetch", { url: urls[0], limit: 100_000 })).structuredContent.results[0];
  assert.equal(page.url, urls[0]);
  assert.equal(page.fetchedUrl, urls[0]);
  assert.ok(page.range.hasNext);
  const next = (await h.call("web_fetch", { url: page.url, offset: page.range.nextOffset })).structuredContent.results[0];
  assert.equal(next.cached, true);
  assert.equal(page.content + next.content, "a".repeat(60_000));
});

test("registered library docs omit whole oversized snippets with exact omission counts", async t => {
  const h = harness(t);
  const small = { codeTokens: 3, codeList: [{ language: "js", code: "small();" }] };
  const info = { pageId: "https://docs.test/" + "p".repeat(1400), content: "complete documentation" };
  t.mock.method(globalThis, "fetch", async () => json({
    codeSnippets: [{ codeTokens: 15000, codeList: [{ language: "js", code: "x".repeat(60_000) }] }, small],
    infoSnippets: [info],
  }));
  const out = await h.call("library_docs", { libraryId: "/example/lib", query: "q" });
  assert.deepEqual(out.structuredContent.codeSnippets, [small]);
  assert.deepEqual(out.structuredContent.infoSnippets, [info]);
  assert.equal(out.structuredContent.omittedCodeSnippetCount, 1);
  assert.equal(out.structuredContent.omittedInfoSnippetCount ?? 0, 0);
  assert.equal(out.details.omittedCodeSnippetCount, 1);
});

for (const provider of ["tinyfish", "firecrawl"]) {
  test(`registered Exa fallback translates freshness for ${provider}`, async t => {
    const h = harness(t, provider === "tinyfish" ? { TINYFISH_API_KEY: "synthetic-tinyfish" } : { FIRECRAWL_API_KEY: "synthetic-firecrawl" });
    let expected;
    let fallbackCalls = 0;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.includes("exa.ai")) return json({ results: [] });
      fallbackCalls++;
      assert.equal(body[provider === "tinyfish" ? "ttl" : "maxAge"], expected);
      return provider === "tinyfish"
        ? json({ results: [{ url: a, text: "fresh fallback" }] })
        : json({ data: { markdown: "fresh fallback" } });
    });
    for (const [input, age] of [[{ maxAgeHours: 0 }, 0], [{ maxAgeHours: 2 }, 7_200_000], [{ maxAgeMs: 500 }, 0], [{ refresh: true, maxAgeHours: -1 }, 0]]) {
      expected = provider === "tinyfish" ? age / 1000 : age;
      const page = (await h.call("web_fetch", { url: a, ...input })).structuredContent.results[0];
      assert.equal(page.content, "fresh fallback");
    }
    assert.equal(fallbackCalls, 4);
    const page = (await h.call("web_fetch", { url: a, maxAgeHours: -1 })).structuredContent.results[0];
    assert.ok(page.error, "cached-only Exa requests must not trigger live fallback");
    assert.equal(fallbackCalls, 4);
  });
}

test("freshness-constrained Exa calls do not use an uncontrolled markdown fallback", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://api.exa.ai/contents");
    return json({ results: [] });
  });
  const result = await h.call("web_fetch", { url: a, maxAgeHours: 0 });
  assert.ok(result.structuredContent.results[0].error);
  assert.equal(fetchCache.size, 0);
});

test("registered Exa fetch never treats document prose as a provider failure", async t => {
  const h = harness(t, { TINYFISH_API_KEY: "synthetic-tinyfish" });
  const content = 'When the UI displays "No results found", clear the search filter.';
  let calls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    calls++;
    assert.equal(url, "https://api.exa.ai/contents");
    return json({ results: [{ url: a, text: content }] });
  });
  assert.equal((await h.call("web_fetch", { url: a })).structuredContent.results[0].content, content);
  assert.equal(calls, 1);
});

test("registered TinyFish fetch exposes bounded links and image links through cached reads", async t => {
  const h = harness(t, { PI_WEB_KIT_PROVIDER_FETCH: "tinyfish", TINYFISH_API_KEY: "synthetic-tinyfish" });
  const links = Array.from({ length: 100 }, (_, i) => `https://links.test/${i}/${"x".repeat(1400)}`);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.links, true);
    assert.equal(body.image_links, true);
    return json({ results: [{ url: a, text: "page", links: [...links, "javascript:bad()", "https://user:password@test/"],
      image_links: ["https://images.test/a.png"], private: "unpublished metadata" }] });
  });
  for (const cached of [false, true]) {
    const page = (await h.call("web_fetch", { url: a, links: true, imageLinks: true })).structuredContent.results[0];
    assert.ok(page.links.length > 0 && page.links.length < links.length);
    assert.ok(page.links.every(url => links.includes(url)));
    assert.equal(page.links.length + page.omittedLinkCount, 102);
    assert.deepEqual(page.imageLinks, ["https://images.test/a.png"]);
    assert.equal(page.cached, cached);
    assert.equal(page.content, "page");
    assert.doesNotMatch(JSON.stringify(page), /password|unpublished|javascript/);
  }
  assert.equal(calls, 1);
});

test("registered tools use Pi's custom agent directory without trusting project config", async t => {
  const h = harness(t);
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "pi-web-kit.json"), JSON.stringify({ provider_fetch: "markdown_new" }));
  writeFileSync(join(h.home, ".pi-web-kit.json"), JSON.stringify({ provider_fetch: "tinyfish" }));
  h.reload();
  assert.ok(h.tools.get("web_fetch").parameters.properties.method);
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://markdown.new/");
    return new Response("custom agent directory");
  });
  assert.equal((await h.call("web_fetch", { url: a })).structuredContent.provider, "markdown_new");
});

test("web renderers remove terminal controls while preserving theme styling", async t => {
  const h = harness(t, { PI_WEB_KIT_PROVIDER_FETCH: "markdown_new" });
  const theme = { fg: (_color, text) => `\x1b[32m${text}\x1b[39m`, bold: text => text };
  const attack = "\x1b]52;c;dGVzdA==\x07\x1b[2J\r\ninjected\u202e";
  const check = component => {
    const text = component.render(80).join("\n");
    assert.doesNotMatch(text, /\x1b\]52|\x1b\[2J|\r|\u202e/);
    assert.match(text, /\x1b\[32m/, "theme styling remains");
  };
  for (const name of ["web_search", "web_fetch"]) {
    const tool = h.tools.get(name);
    check(tool.renderCall(name === "web_search" ? { query: attack } : { url: attack }, theme));
    const details = name === "web_search"
      ? { queries: [{ query: attack, resultCount: 0 }] }
      : { results: [{ url: attack, error: attack }] };
    check(tool.renderResult({ content: [], details }, { expanded: true, isPartial: false }, theme, { state: {} }));
    const context = { state: {}, invalidate() {} };
    try {
      check(tool.renderResult({ content: [], details: { progress: {
        kind: name === "web_search" ? "search" : "fetch", total: 1, completed: 0,
        items: [{ label: attack, status: "current", error: attack }],
      } } }, { expanded: true, isPartial: true }, theme, context));
    } finally {
      tool.renderResult({ content: [], details }, { expanded: true, isPartial: false }, theme, context);
    }
  }
});

for (const provider of ["tinyfish", "firecrawl"]) {
  test(`registered Exa fallback via ${provider} keeps redirect identity and cached failures separate`, async t => {
    const h = harness(t, provider === "tinyfish" ? { TINYFISH_API_KEY: "synthetic-tinyfish" } : { FIRECRAWL_API_KEY: "synthetic-firecrawl" });
    let aCalls = 0;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.includes("exa.ai")) return json({ results: [] });
      if (url.includes("markdown.new")) return json({}, 404);
      if (provider === "tinyfish") {
        if (body.urls.some(url => url === a)) aCalls++;
        return json({ results: body.urls.some(url => url === a) ? [{ url: a, final_url: b, text: "redirected fallback A" }] : [],
          errors: [{ url: b, error: "missing" }] });
      }
      if (body.url === a) { aCalls++; return json({ data: { url: b, markdown: "redirected fallback A" } }); }
      return json({}, 404);
    });
    for (const cached of [false, true]) {
      const result = (await h.call("web_fetch", { urls: [a, b] })).structuredContent.results;
      assert.equal(result[0].url, a);
      assert.equal(result[0].fetchedUrl, b);
      assert.equal(result[0].content, "redirected fallback A");
      assert.equal(result[0].cached, cached);
      assert.equal(result[1].url, b);
      assert.ok(result[1].error);
      assert.equal(result[1].content, undefined);
    }
    assert.equal(aCalls, 1);
  });
}

test("oversized documentation never publishes partial code or stale token counts", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async () => json({
    codeSnippets: [{ codeTokens: 60_000, codeList: [{ language: "js", code: "界🙂".repeat(60_000) }] }],
    infoSnippets: [{ content: "x".repeat(60_000), contentTokens: 15_000 }],
  }));
  const result = await h.call("library_docs", { libraryId: "/example/lib", query: "q" });
  assert.deepEqual(result.structuredContent.codeSnippets, []);
  assert.deepEqual(result.structuredContent.infoSnippets, []);
  assert.equal(result.structuredContent.omittedCodeSnippetCount, 1);
  assert.equal(result.structuredContent.omittedInfoSnippetCount, 1);
  assert.match(result.structuredContent.message, /Refine/);
  const tool = h.tools.get("library_docs");
  const theme = { fg: (_color, text) => text, bold: text => text };
  const rendered = tool.renderResult(result, { expanded: true }, theme, {}).render(160).join("\n");
  assert.match(rendered, /Output limit reached/);
  assert.match(rendered, /1 code snippet omitted/);
  assert.match(rendered, /Refine/);
});

test("an oversized first search title cannot hide smaller ranked sources", async t => {
  const h = harness(t);
  const urls = [a, b, "https://c.test/page"];
  t.mock.method(globalThis, "fetch", async () => json({ results: urls.map((url, i) => ({
    url, title: i === 0 ? "界🙂".repeat(20_000) : `Source ${i}`, highlights: ["useful evidence"],
  })) }));
  const group = (await h.call("web_search", { query: "q", purpose: "Find evidence", numResults: 3 })).structuredContent.queries[0];
  assert.deepEqual(group.results.map(source => source.url), urls);
  assert.equal(group.resultCount, 3);
  assert.equal(group.omittedResultCount, 0);
  assert.ok(group.results[0].title.length <= 1000);
  assert.ok(!group.results[0].title.endsWith("\ud83d"));
  assert.ok(group.results.every(source => source.content === "useful evidence"));
});

test("registered library search omits whole oversized candidates without modifying IDs or versions", async t => {
  const h = harness(t);
  const small = { id: "/example/lib", versions: ["v1", "v2"] };
  t.mock.method(globalThis, "fetch", async () => json({ results: [
    { id: "/huge/lib", description: "x".repeat(60_000), versions: ["v".repeat(2000)] }, small,
  ] }));
  const result = await h.call("library_search", { libraryName: "lib" });
  assert.deepEqual(result.structuredContent.results, [small]);
  assert.equal(result.structuredContent.omittedResultCount, 1);
  assert.equal(result.details.omittedResultCount, 1);
});

for (const name of ["web_fetch", "library_docs"]) {
  for (const advertised of [true, false]) {
    test(`${name} rejects oversized ${advertised ? "Content-Length" : "streamed bodies"} before caching/publication`, async t => {
      const h = harness(t, { PI_WEB_KIT_PROVIDER_FETCH: "markdown_new" });
      let cancelled = false;
      let reads = 0;
      t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(120));
        },
        cancel() { cancelled = true; },
      }), { headers: advertised ? { "content-length": String(MAX_RESPONSE_BYTES + 1) } : {} }));
      if (name === "web_fetch") {
        const page = (await h.call(name, { url: a })).structuredContent.results[0];
        assert.equal(page.content, undefined);
        assert.match(page.error, /Provider response exceeded 8388608 bytes/);
      } else {
        await assert.rejects(h.call(name, { libraryId: "/example/lib", query: "q" }), /Provider response exceeded 8388608 bytes/);
      }
      assert.equal(cancelled, true);
      assert.ok(reads <= (advertised ? 1 : 10), "stop reading immediately once the byte limit is exceeded");
      assert.equal(fetchCache.size, 0);
    });
  }
}

test("cache budget includes keys, titles and metadata, ignoring caller byte estimates", () => {
  const cache = new FetchCache({ maxEntries: 10, maxBytes: 1000, ttlMs: 1000 });
  const page = { provider: "test", cacheKey: "k", requestedUrl: a, url: a,
    content: "small", title: "large".repeat(1000), format: "markdown", fetchedAt: 0,
    metadata: { oversized: "x".repeat(2000) }, bytes: 1 };
  const stored = cache.set("k", page, 0);
  assert.ok(stored.bytes > 6000);
  assert.equal(cache.size, 0);
  assert.equal(cache.totalCachedBytes, 0);
  cache.set("k".repeat(2000), { ...page, title: "", metadata: {} }, 0);
  assert.equal(cache.totalCachedBytes, 0);
});

test("registered fetch never retains raw provider metadata in the cache", async t => {
  const h = harness(t, { PI_WEB_KIT_PROVIDER_FETCH: "tinyfish", TINYFISH_API_KEY: "synthetic-tinyfish" });
  t.mock.method(globalThis, "fetch", async () => json({ results: [{
    url: a, text: "small", private: "x".repeat(2 * 1024 * 1024),
  }] }));
  assert.equal((await h.call("web_fetch", { url: a })).structuredContent.results[0].content, "small");
  assert.equal(fetchCache.size, 1);
  assert.ok(fetchCache.totalCachedBytes < 2000);
});

test("all registered provider paths reject redirects for credential-bearing requests", async t => {
  for (const search of ["exa", "tinyfish", "brave", "firecrawl"]) {
    for (const fetch of ["exa", "tinyfish", "firecrawl", "markdown_new"]) {
      await t.test(`${search}/${fetch}`, async child => {
        const h = harness(child, { PI_WEB_KIT_PROVIDER_SEARCH: search, PI_WEB_KIT_PROVIDER_FETCH: fetch,
          TINYFISH_API_KEY: "synthetic-tinyfish", BRAVE_SEARCH_API_KEY: "synthetic-brave", FIRECRAWL_API_KEY: "synthetic-firecrawl" });
        let calls = 0;
        child.mock.method(globalThis, "fetch", async (_url, init) => {
          calls++;
          assert.equal(init.redirect, "error");
          throw new TypeError("fetch failed: unexpected redirect");
        });
        await assert.rejects(h.call("web_search", { query: "q", purpose: "Find q" }));
        if (["tinyfish", "exa"].includes(fetch)) await assert.rejects(h.call("web_fetch", { url: a }));
        else assert.ok((await h.call("web_fetch", { url: a })).structuredContent.results[0].error);
        await assert.rejects(h.call("library_search", { libraryName: "lib" }));
        await assert.rejects(h.call("library_docs", { libraryId: "/example/lib", query: "q" }));
        await assert.rejects(h.call("code_search", { query: "q", purpose: "Implement q" }));
        assert.equal(calls, 5);
      });
    }
  }
});

test("native HTTP redirect rejection never forwards a custom API key", async () => {
  let forwarded = 0;
  const server = createServer((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/sink" }); res.end(); }
    else { forwarded++; res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/start`;
    await assert.rejects(requestJson(url, { headers: { "X-API-Key": "synthetic-only" } }));
    assert.equal(forwarded, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
