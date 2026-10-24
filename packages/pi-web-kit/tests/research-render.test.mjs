import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import extension, { jsonToolResult } from "../extensions/index.ts";
import { WEB_OUTPUT_SCHEMAS } from "../src/output.ts";

const names = ["library_search", "library_docs", "code_search"];
const theme = { fg: (_color, text) => text, bold: text => text };
const args = {
  library_search: { libraryName: "Example", query: "API examples" },
  library_docs: { libraryName: "Example", query: "API examples" },
  code_search: { query: "API examples", purpose: "Implement an API client" },
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function harness(t) {
  const saved = { ...process.env };
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-render-"));
  Object.assign(process.env, {
    HOME: cwd, PI_TELEMETRY: "0",
    CONTEXT7_API_KEY: "synthetic-context-key", EXA_API_KEY: "synthetic-exa-key",
  });
  delete process.env.PI_WEB_KIT_PROVIDER_SEARCH;
  delete process.env.PI_WEB_KIT_PROVIDER_FETCH;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(cwd, { recursive: true, force: true });
  });
  const tools = new Map();
  let start;
  extension({
    registerFlag() {}, getFlag() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { if (name === "session_start") start = handler; },
  });
  const ctx = { cwd, mode: "print", isProjectTrusted: () => false };
  start({}, ctx);
  return {
    tools,
    async call(name, input = args[name], signal) {
      const updates = [];
      const result = await tools.get(name).execute("test", input, signal, update => updates.push(update), ctx);
      assert.ok(Check(WEB_OUTPUT_SCHEMAS[name], result.structuredContent));
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 50_000);
      return { result, updates };
    },
  };
}

function render(tool, result, { expanded = false, isPartial = false, isError = false, width = 80, colors = theme } = {}) {
  const component = tool.renderResult(result, { expanded, isPartial }, colors, { isError, args: args[tool.name], state: {} });
  const lines = component.render(width);
  assert.ok(lines.every(line => visibleWidth(line) <= width && !line.includes("\n")));
  return lines;
}

test("registered library_search renders ranked candidates on expansion without changing its data", async t => {
  const h = harness(t);
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    id: `/example/library-${index}`, title: `Library ${index}`,
    description: "DO NOT RENDER THIS DESCRIPTION".repeat(30),
    versions: ["v4", "v3", "v2", "v1"], trustScore: 8, state: "finalized",
  }));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return json({ results: candidates }); });
  const { result, updates } = await h.call("library_search");
  const tool = h.tools.get("library_search");
  const before = JSON.stringify(result);
  assert.equal(requests, 1);
  assert.equal(result.structuredContent.results.length, 10);
  assert.equal(result.structuredContent.results[0].description, candidates[0].description);
  const collapsed = render(tool, result);
  assert.equal(collapsed.length, 2);
  assert.match(collapsed.join("\n"), /Library search complete\n.*10 candidates.*Context7/);
  assert.doesNotMatch(collapsed.join("\n"), /library-0|DO NOT RENDER|finalized|trustScore/);
  const expanded = render(tool, result, { expanded: true }).join("\n");
  assert.ok(expanded.indexOf("library-0") < expanded.indexOf("library-9"));
  assert.match(expanded, /versions: v4, v3 · \+2 more/);
  assert.doesNotMatch(expanded, /v2|v1|DO NOT RENDER|official|recommended/i);
  assert.equal(updates.length, 1);
  assert.match(render(tool, updates[0], { isPartial: true }).join("\n"), /Searching libraries/);
  assert.equal(JSON.stringify(result), before);
  assert.match(tool.renderCall(args.library_search, theme, {}).render(80)[0], /^library_search Example$/);
});

test("registered library_docs shows resolved library and sources, never snippet bodies", async t => {
  const h = harness(t);
  const paths = [];
  t.mock.method(globalThis, "fetch", async url => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname.endsWith("/libs/search")) return json({ results: [{ id: "/example/resolved" }] });
    assert.equal(parsed.searchParams.get("libraryId"), "/example/resolved");
    return json({
      codeSnippets: [{ codeId: "https://example.test/code", codeList: [{ language: "js", code: "PRIVATE_SNIPPET()" }] }],
      infoSnippets: [{ pageId: "https://example.test/guide", content: "PRIVATE_DOCS" }],
    });
  });
  const { result, updates } = await h.call("library_docs");
  const tool = h.tools.get("library_docs");
  const before = JSON.stringify(result);
  assert.deepEqual(paths, ["/api/v2/libs/search", "/api/v2/context"]);
  assert.equal(result.structuredContent.codeSnippets[0].codeList[0].code, "PRIVATE_SNIPPET()");
  assert.equal(result.structuredContent.infoSnippets[0].content, "PRIVATE_DOCS");
  assert.match(render(tool, result).join("\n"), /1 code snippet · 1 text snippet · Context7/);
  const expanded = render(tool, result, { expanded: true }).join("\n");
  assert.match(expanded, /\/example\/resolved/);
  assert.match(expanded, /https:\/\/example.test\/code/);
  assert.match(expanded, /https:\/\/example.test\/guide/);
  assert.doesNotMatch(expanded, /PRIVATE_/);
  assert.match(render(tool, updates[0], { isPartial: true }).join("\n"), /Looking up library documentation/);
  assert.equal(JSON.stringify(result), before);
  assert.match(tool.renderCall({ libraryId: "/example/pinned" }, theme, {}).render(80)[0], /\/example\/pinned/);
});

test("registered code_search expands source identities and reports reduced evidence", async t => {
  const h = harness(t);
  const body = "DO_NOT_RENDER_CODE ".repeat(200);
  t.mock.method(globalThis, "fetch", async () => json({ results: [
    { title: "First source", url: "https://example.test/first", highlights: [body] },
    { url: "https://example.test/second", highlights: ["example()"] },
    { url: "https://example.test/no-content" },
  ] }));
  const { result, updates } = await h.call("code_search", { ...args.code_search, contextTokens: 5 });
  const tool = h.tools.get("code_search");
  const before = JSON.stringify(result);
  assert.equal(result.structuredContent.resultCount, 2);
  assert.ok(result.structuredContent.omittedContextCharacters > 0);
  assert.equal(result.structuredContent.omittedNoContentCount, 1);
  assert.match(render(tool, result).join("\n"), /2 sources · Exa · output reduced/);
  const expanded = render(tool, result, { expanded: true }).join("\n");
  assert.match(expanded, /context chars omitted/);
  assert.match(expanded, /1 source without excerpts/);
  assert.match(expanded, /1\. First source\n.*https:\/\/example.test\/first/);
  assert.match(expanded, /2\. https:\/\/example.test\/second/);
  assert.doesNotMatch(expanded, /DO_NOT_RENDER_CODE/);
  assert.match(render(tool, updates[0], { isPartial: true }).join("\n"), /Searching code/);
  assert.equal(JSON.stringify(result), before);
  assert.match(tool.renderCall(args.code_search, theme, {}).render(80)[0], /^code_search API examples$/);
});

for (const name of names) {
  test(`${name} handles empty, failure, cancellation, and output-limit results`, async t => {
    const h = harness(t);
    const tool = h.tools.get(name);
    const input = name === "library_docs" ? { libraryId: "/example/lib", query: "q" } : args[name];
    t.mock.method(globalThis, "fetch", async () => json({ results: [], codeSnippets: [], infoSnippets: [] }));
    const { result } = await h.call(name, input);
    const empty = render(tool, result).join("\n");
    assert.match(empty, /No (matching libraries|documentation found|code results)/);
    assert.doesNotMatch(empty, /complete/);

    globalThis.fetch = async () => json({ private: "DO_NOT_ECHO_BACKEND_BODY" }, 403);
    await assert.rejects(h.call(name, input), error => {
      const failed = render(tool, { content: [{ type: "text", text: error.message }], details: undefined }, { isError: true }).join("\n");
      assert.match(failed, /failed\n.*HTTP 403/);
      assert.doesNotMatch(failed, /complete|DO_NOT_ECHO/);
      return true;
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(h.call(name, input, controller.signal), /Web tool cancelled/);

    const truncated = jsonToolResult({ truncated: true, message: "Structured result exceeded 50KB; refine the request." }, WEB_OUTPUT_SCHEMAS[name]);
    assert.match(render(tool, truncated).join("\n"), /Output limit reached\n.*refine the request/);
    assert.doesNotMatch(render(tool, truncated).join("\n"), /complete|truncated":true/);
  });

  test(`${name} bounds physical rows, handles legacy details, and preserves theme styling`, t => {
    const { tools } = harness(t);
    const tool = tools.get(name);
    const legacy = { content: [{ type: "text", text: JSON.stringify({ results: "界🙂".repeat(2000) }) }], details: undefined };
    const error = { content: [{ type: "text", text: "error\n".repeat(100) }], details: undefined };
    const colors = { fg: (_color, text) => `\x1b[32m${text}\x1b[39m`, bold: text => text };
    for (const width of [0, 1, 20, 60, 80, 120]) {
      assert.ok(render(tool, legacy, { width, colors }).length <= 2);
      assert.ok(render(tool, legacy, { width, expanded: true }).length <= 12);
      assert.ok(render(tool, error, { width, isError: true }).length <= 2);
      assert.ok(render(tool, error, { width, expanded: true, isError: true }).length <= 12);
      const call = tool.renderCall({ libraryName: "界🙂".repeat(2000), query: "界🙂".repeat(2000) }, colors, {}).render(width);
      assert.equal(call.length, width ? 1 : 0);
      assert.ok(call.every(line => visibleWidth(line) <= width));
    }
    const styled = render(tool, legacy, { colors })[0];
    assert.ok(styled.includes("\x1b[32m"));
    assert.equal(stripVTControlCharacters(styled), "Result preview");
  });
}

test("provider-controlled fields cannot inject terminal controls or expand row budgets", async t => {
  const h = harness(t);
  const hostile = "界🙂\x1b[31mRED\x1b[0m\n\t\u202e" + "long".repeat(2000);
  t.mock.method(globalThis, "fetch", async () => json({ results: [{
    id: `/example/${hostile}`, title: `synthetic-context-key ${hostile}`,
    versions: Array.from({ length: 1000 }, (_, index) => `v${index}`),
  }] }));
  const { result } = await h.call("library_search");
  const tool = h.tools.get("library_search");
  assert.ok(result.structuredContent.results[0].id.includes("\x1b[31m"), "display cleanup must not alter the data contract");
  for (const width of [1, 20, 60, 80, 120]) {
    for (const expanded of [false, true]) {
      const lines = render(tool, result, { width, expanded });
      assert.ok(lines.length <= (expanded ? 5 : 2));
      // Pi's width truncator inserts its own style resets, even with a plain theme.
      assert.doesNotMatch(lines.join("\n").replace(/\x1b\[0m/g, ""), /\x1b|\u202e|synthetic-context-key/);
    }
  }
});

test("all registered success renderers fit narrow terminals with minimal optional metadata", t => {
  const { tools } = harness(t);
  const data = {
    library_search: { provider: "context7", libraryName: "Example", query: "q", results: [{ id: "/example/library" }] },
    library_docs: { provider: "context7", libraryId: "/example/library", query: "q",
      codeSnippets: [{}], infoSnippets: [{ content: "Keep this in the data" }] },
    code_search: { provider: "exa", query: "q", searchType: "auto", maxAgeHours: 0,
      requestedResultLimit: 5, effectiveResultLimit: 5, effectiveContextTokens: 10,
      resultCount: 1, contextCharacters: 10, omittedResultCount: 2,
      results: [{ url: "https://example.test/code", content: "example();" }] },
  };
  for (const name of names) {
    const tool = tools.get(name);
    const result = jsonToolResult(data[name], WEB_OUTPUT_SCHEMAS[name]);
    for (const width of [0, 1, 20, 60, 80, 120]) {
      assert.equal(render(tool, result, { width }).length, width ? 2 : 0);
      const expanded = render(tool, result, { width, expanded: true });
      assert.ok(expanded.length <= 5);
      assert.doesNotMatch(expanded.join("\n"), /undefined|null|Keep this in the data|example\(\)/);
    }
    const call = tool.renderCall({}, theme, {}).render(80).map(stripVTControlCharacters).join("\n");
    assert.match(call, /…/);
  }
  assert.match(render(tools.get("code_search"), jsonToolResult(data.code_search, WEB_OUTPUT_SCHEMAS.code_search),
    { expanded: true }).join("\n"), /2 sources omitted/);
});
