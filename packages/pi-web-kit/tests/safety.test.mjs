import test from "node:test";
import assert from "node:assert/strict";
import { FetchCache } from "../src/cache.ts";
import { fetchWithTimeout, mapConcurrent, normalizeUrls } from "../src/http.ts";
import { ExaProvider } from "../src/providers/exa.ts";
import { FirecrawlProvider } from "../src/providers/firecrawl.ts";
import { MarkdownNewProvider } from "../src/providers/markdown-new.ts";
import { fetchWithCache } from "../extensions/index.ts";
import { mapFetchResults } from "../src/providers/fallback.ts";

const cfg = (apiKeys = {}) => ({ provider_search: "exa_mcp", provider_fetch: "exa_mcp", apiKeys, markdownNew: { method: "auto", retainImages: false } });

test("FetchCache enforces TTL, LRU, max entries, and max bytes", () => {
  const ttl = new FetchCache({ maxEntries: 10, maxBytes: 10_000, ttlMs: 10 });
  ttl.set("a", page("a", "aaaa", 0), 0);
  assert.equal(ttl.get("a", 11), undefined);

  const entries = new FetchCache({ maxEntries: 2, maxBytes: 10_000, ttlMs: 1_000 });
  entries.set("a", page("a", "a", 0), 0);
  entries.set("b", page("b", "b", 0), 1);
  assert(entries.get("a", 2));
  entries.set("c", page("c", "c", 0), 3);
  assert(entries.get("a", 4));
  assert.equal(entries.get("b", 4), undefined);

  const bytes = new FetchCache({ maxEntries: 10, maxBytes: 5, ttlMs: 1_000 });
  bytes.set("a", page("a", "1234", 0), 0);
  bytes.set("b", page("b", "1234", 1), 1);
  assert.equal(bytes.get("a", 2), undefined);
  assert(bytes.get("b", 2));
});

test("URL normalization rejects bad URLs and deduplicates fragments", () => {
  assert.throws(() => normalizeUrls({ url: "ftp://example.com" }), /scheme/);
  assert.throws(() => normalizeUrls({ url: "https://u:p@example.com" }), /credentials/);
  assert.throws(() => normalizeUrls({ url: "not a url" }), /Malformed/);
  assert.deepEqual(normalizeUrls({ urls: ["https://example.com/a#one", "https://example.com/a#two"] }), ["https://example.com/a"]);
  assert.throws(() => normalizeUrls({ urls: Array.from({ length: 11 }, (_, i) => `https://e.test/${i}`) }), /Too many URLs/);
});

test("mapConcurrent bounds active work", async () => {
  let active = 0;
  let maxActive = 0;
  const out = await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
});

test("fetchWithTimeout aborts slow requests", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  try {
    await assert.rejects(() => fetchWithTimeout("https://slow.test", { timeoutMs: 1 }), /timed out/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("MarkdownNewProvider uses bounded concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response("ok", { status: 200 });
  };
  try {
    const provider = new MarkdownNewProvider(cfg());
    await provider.fetch({ urls: Array.from({ length: 7 }, (_, i) => `https://e.test/${i}`) });
    assert(maxActive <= 3);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Exa fetch matches canonical/trailing-slash URLs and falls back by index", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [
    { url: "https://example.com/a/", title: "A", text: "one" },
    { url: "https://other.test/redirected", title: "B", text: "two" },
  ] }), { status: 200 });
  try {
    const provider = new ExaProvider(cfg({ exa: "key" }));
    const out = await provider.fetch({ urls: ["https://example.com/a", "https://example.com/b"] });
    assert.equal(out.results[0].content, "one");
    assert.equal(out.results[1].content, "two");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("mapFetchResults never assigns an exact match twice", () => {
  const mapped = mapFetchResults(["https://a.test", "https://b.test"], {
    provider: "test",
    results: [{ url: "https://b.test", content: "B" }],
  });
  assert.equal(mapped.has("https://a.test"), false);
  assert.equal(mapped.get("https://b.test").content, "B");
});

test("mapFetchResults prioritizes exact matches then consumes unmatched results once", () => {
  const mapped = mapFetchResults(["https://a.test", "https://b.test", "https://c.test"], {
    provider: "test",
    results: [
      { url: "https://redirect.test", content: "redirect" },
      { url: "https://b.test/", content: "B" },
    ],
  });
  assert.equal(mapped.get("https://b.test").content, "B");
  assert.equal(mapped.get("https://a.test").content, "redirect");
  assert.equal(mapped.has("https://c.test"), false);
  assert.equal(new Set(mapped.values()).size, mapped.size);
});

test("fetchWithCache preserves requested URL when provider returns canonical URL", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ url: "https://example.com/page/", title: "T", text: "body" }] }), { status: 200 });
  try {
    const out = await fetchWithCache("exa", { url: "https://example.com/page", refresh: true }, ["https://example.com/page"], undefined, { ...cfg({ exa: "key" }), provider_fetch: "exa" });
    assert.equal(out.results[0].url, "https://example.com/page");
    assert.equal(out.results[0].fetchedUrl, "https://example.com/page/");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Firecrawl fetch returns selected markdown, html, and json formats", async () => {
  const seen = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.formats[0]);
    return new Response(JSON.stringify({ data: { markdown: "md", html: "<p>html</p>", json: { ok: true }, metadata: { title: "T" } } }), { status: 200 });
  };
  try {
    const provider = new FirecrawlProvider(cfg({ firecrawl: "key" }));
    assert.equal((await provider.fetch({ url: "https://e.test", format: "markdown" })).results[0].content, "md");
    assert.equal((await provider.fetch({ url: "https://e.test", format: "html" })).results[0].content, "<p>html</p>");
    assert.equal((await provider.fetch({ url: "https://e.test", format: "json" })).results[0].content, '{\n  "ok": true\n}');
    assert.deepEqual(seen, ["markdown", "html", "json"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

function page(url, content, fetchedAt) {
  return { provider: "test", cacheKey: url, requestedUrl: url, url, content, format: "markdown", fetchedAt };
}
