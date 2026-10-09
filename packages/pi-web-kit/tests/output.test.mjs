import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { jsonToolResult, pageSlice } from "../extensions/index.ts";
import { projectOutput, publicPageError, redactOutput, WEB_OUTPUT_SCHEMAS } from "../src/output.ts";
import { requestJson } from "../src/http.ts";

function validates(name, data, secrets = []) {
  const result = jsonToolResult(data, WEB_OUTPUT_SCHEMAS[name], secrets);
  assert.ok(Check(WEB_OUTPUT_SCHEMAS[name], result.structuredContent));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50_000);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= 50_000);
  return result;
}

test("output projection omits unknown/invalid optional fields and rejects invalid required data", () => {
  const result = validates("library_search", {
    provider: "context7", libraryName: "fixture", query: "fixture", cacheKey: "private",
    results: [{ id: "/fixture/library", title: null, stars: "not a number", versions: ["v1"], extra: "private" }],
  });
  assert.deepEqual(result.structuredContent.results, [{ id: "/fixture/library", versions: ["v1"] }]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.throws(() => projectOutput(WEB_OUTPUT_SCHEMAS.library_search, {
    provider: "context7", libraryName: "fixture", query: "fixture", results: [{ id: 5 }],
  }), /invalid result shape/);
  assert.throws(() => projectOutput(WEB_OUTPUT_SCHEMAS.web_fetch, {
    provider: "exa", results: [{ url: "u", error: { unrestricted: "body" } }],
  }), /invalid result shape/);
});

test("empty results and docs with absent snippet metadata have stable schemas", () => {
  validates("library_search", { provider: "context7", libraryName: "empty", query: "q", results: [] });
  validates("library_docs", { provider: "context7", libraryId: "/fixture/lib", query: "q", codeSnippets: [], infoSnippets: [] });
  validates("code_search", { provider: "exa", query: "empty", response: "" });
  const docs = validates("library_docs", {
    provider: "context7", libraryId: "/fixture/lib", query: "q",
    codeSnippets: [{ codeList: [{ language: "js", code: "example()", token: "private" }] }],
    infoSnippets: [{ content: "info", pageId: null }], rules: { token: "private" },
  });
  assert.doesNotMatch(JSON.stringify(docs), /private|rules|pageId/);
});

test("bounded UTF-8 fetch content and partial failures validate after truncation", () => {
  const content = "界🙂\"\\\n".repeat(20_000);
  const page = pageSlice({ url: "https://fixture.invalid", content, format: "markdown", fetchedAt: 1 }, 0, 100_000, false, false);
  const result = validates("web_fetch", { provider: "exa", results: [page, { url: "https://fixture.invalid/error", error: "No content returned." }] });
  const limited = result.structuredContent.results[0];
  assert.ok(limited.range.hasNext);
  assert.equal(limited.range.nextOffset, limited.content.length);
  assert.equal(limited.range.returned, limited.content.length);
  assert.equal(limited.range.total, content.length);
  assert.equal(result.details.results[0].content, undefined);
});

test("search omitted-count fields and top-level truncation fallback validate", () => {
  const result = validates("web_search", { provider: "exa", queries: [{
    query: "q", requestedResultLimit: 100, effectiveResultLimit: 100, effectiveContextTokens: 10000,
    contextCharacters: 100000, resultCount: 100,
    results: Array.from({ length: 100 }, () => ({ url: "u".repeat(2048), title: "t".repeat(2000), content: "界".repeat(1000) })),
  }] });
  assert.ok(result.structuredContent.queries[0].omittedResultCount > 0);
  const fallback = validates("library_docs", {
    provider: "context7", libraryId: "/fixture/lib", query: "q", codeSnippets: [],
    infoSnippets: Array.from({ length: 200 }, () => ({ content: "x".repeat(2000) })),
  });
  assert.equal(fallback.structuredContent.truncated, true);
});

test("known credentials and transport patterns are redacted before output bounding", () => {
  const secret = "synthetic-api-key";
  const text = `${secret} https://user:password@fixture.invalid/p?token=secret-token Basic YWJj Omitting this is safe.`;
  const result = validates("code_search", { provider: "exa", query: secret, response: text.repeat(5000) }, [secret]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-api-key|password|secret-token|YWJj/);
  assert.deepEqual(redactOutput({ nested: [secret], count: 1 }, [secret]), { nested: ["*".repeat(secret.length)], count: 1 });
  assert.equal(publicPageError("private unrestricted backend body"), "Provider could not fetch this page.");
});

test("HTTP and JSON parse failures do not echo backend bodies", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("private response body", { status: 403 }));
  await assert.rejects(requestJson("https://fixture.invalid"), { message: "Provider request failed (HTTP 403)." });
  globalThis.fetch = async () => new Response("private invalid JSON");
  await assert.rejects(requestJson("https://fixture.invalid"), { message: "Provider returned invalid JSON." });
});
