import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createCodemodeExtension, createToolSearchExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { codexHarness, requestBody, textResponse } from "./codex-harness.mjs";

// No user profiles, credentials, Git remotes or provider requests.
const root = await mkdtemp(join(tmpdir(), "pi-structured-tools-"));
const envOverrides = {
  TMPDIR: root,
  HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_SCOUT_TMPDIR: join(root, "clones"),
  CI: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
  PI_WEB_KIT_PROVIDER_SEARCH: "exa", PI_WEB_KIT_PROVIDER_FETCH: "markdown_new",
  ...Object.fromEntries(["EXA_API_KEY", "CONTEXT7_API_KEY", "TINYFISH_API_KEY", "FIRECRAWL_API_KEY", "BRAVE_SEARCH_API_KEY"]
    .map(key => [key, `synthetic-${key}-secret`])),
};
const savedEnv = Object.fromEntries(Object.keys(envOverrides).map(key => [key, process.env[key]]));
Object.assign(process.env, envOverrides);

function restoreEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const { default: web } = await import("../packages/pi-web-kit/extensions/index.ts");
const { default: scout } = await import("../packages/pi-scout/extensions/index.ts");
const { saveState } = await import("../packages/pi-scout/src/state.ts");
const { default: goal } = await import("../packages/pi-goal/extensions/index.ts");
const { default: patch } = await import("../packages/pi-codex-tools/extensions/index.ts");
const { default: images } = await import("../packages/pi-codex-image-gen/extensions/index.ts");
const { default: processes } = await import("../packages/pi-processes/extensions/index.ts");
const { fetchCache } = await import("../packages/pi-web-kit/src/cache.ts");
let sequence = 0;

function responseFor(request, name, args) {
  const custom = request.tools.find(tool => tool.name === name)?.type === "custom";
  const id = `fixture_${++sequence}`;
  const item = custom
    ? { type: "custom_tool_call", id: `ct_${id}`, call_id: id, name, input: args }
    : { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(name === "codemode" ? { code: args } : args) };
  return new Response([
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(custom ? { input: "" } : { arguments: "" }) } },
    { type: custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
      output_index: 0, item_id: item.id, delta: custom ? item.input : item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
async function fixture(t, { mode = "only", codemodeEnabled = true, inlineBudget = 0, defaultTools, excludeTools, deferred, webConfig, sessionManager, sessionStartEvent, withoutWebHistory = false, extra = [], git } = {}) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network blocked"); });
  await mkdir(process.env.PI_SCOUT_TMPDIR, { recursive: true });
  const configFile = join(process.env.PI_CODING_AGENT_DIR, "pi-web-kit.json");
  t.after(() => rm(configFile, { force: true }));
  if (webConfig) {
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    await writeFile(configFile, JSON.stringify(webConfig));
  }
  await saveState({ repos: [] });
  fetchCache.clear();
  const definitions = new Map();
  const events = [];
  const progress = [];
  const requests = [];
  const providerRequests = [];
  let gitCalls = 0;
  const capture = extension => pi => extension({
    ...pi,
    appendEntry(customType, data) {
      // Simulate sessions made before registration history was introduced.
      if (!withoutWebHistory || customType !== "pi-web-kit:registered-tools") pi.appendEntry(customType, data);
    },
    registerTool(tool) {
      // Synthetic adapter for the native deferred-tool contract.
      const definition = tool.name === deferred ? { ...tool, exposure: "deferred" } : tool;
      definitions.set(tool.name, definition);
      pi.registerTool(definition);
    },
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(args.includes("--"), "separate clone options from the source");
      gitCalls++;
      return git ? git(args, options) : { code: 0, stdout: "", stderr: "" };
    },
  });
  const h = await codexHarness([
    ...(mode === "off" ? [] : [createCodemodeExtension({ mode, inlineBudget })]),
    createToolSearchExtension(),
    ...[web, scout, goal, patch, images].map(capture),
    ...extra,
    pi => {
      pi.on("tool_result", event => { events.push(event); });
    },
  ], { cwd: root, defaultTools: defaultTools ?? (mode === "off" ? ["read"] : ["read", ...(codemodeEnabled ? ["codemode"] : []), "tool_search"]), excludeTools, sessionManager, sessionStartEvent });
  t.after(() => h.close());
  h.session.subscribe(event => {
    if (event.type === "tool_execution_update") progress.push(event.partialResult);
  });
  let next;
  let provider = async (url, init) => {
    const target = String(url);
    if (target === "https://api.exa.ai/search") {
      const body = JSON.parse(init.body);
      const { query } = body;
      assert.equal(typeof body.objective, "string");
      if (body.contents.maxAgeHours === 0) {
        assert.equal(body.type, "auto");
        assert.deepEqual(body.contents, { highlights: true, maxAgeHours: 0, livecrawlTimeout: 15000 });
      }
      return json({ results: query === "empty" ? [] : [{ title: "Fixture", url: "https://fixture.invalid/page",
        highlights: [body.contents.maxAgeHours === 0 ? "Fixture code" : "bounded page context"] }] });
    }
    if (target === "https://markdown.new/") {
      const { url } = JSON.parse(init.body);
      return url.includes("fail")
        ? new Response("arbitrary-backend-body synthetic-EXA_API_KEY-secret", { status: 503 })
        : new Response("Fixture page 界", { headers: { "content-type": "text/markdown" } });
    }
    if (target.startsWith("https://context7.com/api/v2/libs/search")) {
      return json({ results: [{ id: "/fixture/library", title: null, versions: ["v1"], ignored: "raw-body" }] });
    }
    if (target.startsWith("https://context7.com/api/v2/context")) {
      return json({ codeSnippets: [{ codeTitle: "Fixture", codeList: [{ language: "js", code: "example()", authorization: "private" }] }],
        infoSnippets: [{ content: "Fixture docs", contentTokens: null }], rules: { authorization: "private" } });
    }
    throw new Error("Unmocked provider URL");
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/codex/responses")) {
      const request = requestBody(init);
      if (request.tools.some(tool => tool.type === "image_generation")) {
        providerRequests.push({ url: String(url), image: true });
        return provider(url, init);
      }
      requests.push(request);
      if (requests.length > 30) throw new Error("Fixture exceeded bounded model requests");
      if (!next) return textResponse();
      const call = next;
      next = undefined;
      return responseFor(request, ...call);
    }
    providerRequests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return provider(url, init);
  };
  return {
    ...h, definitions, events, requests, providerRequests, progress,
    async setWebConfig(config) {
      await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
      await writeFile(configFile, JSON.stringify(config));
    },
    setCodemode(enabled) {
      h.session.setActiveToolsByName([...h.session.getActiveToolNames().filter(name => name !== "codemode"), ...(enabled ? ["codemode"] : [])]);
    },
    get gitCalls() { return gitCalls; },
    setProvider(value) { provider = value; },
    async run(name, args) {
      next = name ? [name, args] : undefined;
      await h.session.prompt("Synthetic contract fixture only; no real actions or requests.");
      assert.deepEqual(h.errors, []);
      return h.session.messages.findLast(message => message.role === "toolResult");
    },
    script(code) {
      assert.ok(!code.includes("JSON.parse"), "scripts must consume typed results, not parse text");
      return this.run("codemode", code);
    },
  };
}

for (const mode of ["on", "only"]) {
  test(`real codemode ${mode}: fresh code contract cannot escalate mode or omit purpose`, async t => {
    const h = await fixture(t, { mode });
    succeeds(await h.script(`
      const invalid = await Promise.allSettled([
        tools.code_search({query:"Node 22 streams",purpose:"Implement cancellation",type:"lite"}),
        tools.code_search({query:"Node 22 streams",purpose:"Implement cancellation",maxAgeHours:-1}),
        tools.code_search({query:"Node 22 streams",purpose:"Implement cancellation",outputSchema:{}}),
        tools.code_search({query:"Node 22 streams",purpose:"Implement cancellation",tokensNum:"dynamic"}),
        tools.code_search({query:"Node 22 streams"})
      ]);
      if (invalid.some(r=>r.status!=="rejected")) throw new Error("Invalid configuration accepted");
      const code = await tools.code_search({query:"Node 22 streams",purpose:"Deep research is not requested; implement cancellation"});
      if (code.searchType !== "auto" || code.maxAgeHours !== 0 || code.results[0].content !== "Fixture code")
        throw new Error("Fresh retrieval contract lost");
      text(code.resultCount);
    `));
    assert.equal(h.providerRequests.length, 1, "invalid nested calls must fail before provider access");
    assert.equal(h.providerRequests[0].url, "https://api.exa.ai/search");
    assert.deepEqual(h.providerRequests[0].body.contents, { highlights: true, maxAgeHours: 0, livecrawlTimeout: 15000 });
  });
}

function resultText(result) { return result.content.filter(block => block.type === "text").map(block => block.text).join("\n"); }
// Inputs and the outer codemode trace belong to Pi; never claim to redact the
// caller's original arguments. Inspect every surface produced by these tools.
function outputSurfaces(h) {
  return JSON.stringify(h.events.filter(e => e.toolName !== "codemode")
    .map(({ content, details, structuredContent }) => ({ content, details, structuredContent })));
}
function succeeds(result) { assert.equal(result.isError, false, resultText(result)); }
function validates(h, event) {
  assert.ok(Check(h.definitions.get(event.toolName).outputSchema, event.structuredContent),
    `${event.toolName}: ${JSON.stringify(event.structuredContent)}`);
}

for (const mode of ["off", "only"]) {
  for (const failure of ["http", "network", "body"]) {
    test(`partial ${failure} search failures preserve independent queries (${mode})`, async t => {
      const h = await fixture(t, { mode });
      h.setProvider(async (_url, init) => {
        const { query } = JSON.parse(init.body);
        if (query !== "fail") return json({ results: [{ url: "https://fixture.invalid/" + query, title: query, highlights: [query] }] });
        if (failure === "http") return new Response("private backend body", { status: 503 });
        if (failure === "network") throw new TypeError("private network failure synthetic-EXA_API_KEY-secret");
        let reads = 0;
        return new Response(new ReadableStream({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{"private":"backend body'));
            else controller.error(new TypeError("private body failure synthetic-EXA_API_KEY-secret"));
          },
        }));
      });
      const args = { queries: ["first", "fail", "last"], purpose: "Test partial search" };
      succeeds(mode === "off" ? await h.run("web_search", args) : await h.script(`
        const r=await tools.web_search(${JSON.stringify(args)});
        if(r.status!=="partial" || r.queries[0].results.length!==1 || r.queries[2].status!=="success")
          throw new Error("Successful evidence lost");
        text(r.queries.map(q=>({query:q.query,status:q.status})));
      `));
      const event = h.events.findLast(e => e.toolName === "web_search");
      validates(h, event);
      assert.equal(event.structuredContent.status, "partial");
      assert.deepEqual(event.structuredContent.queries.map(q => q.status), ["success", "failed", "success"]);
      assert.equal(event.structuredContent.queries[1].error.code, "provider_request_failed");
      if (failure === "body") {
        assert.equal(event.structuredContent.queries[1].error.message, "Provider response body could not be read.");
      }
      assert.equal(h.providerRequests.length, 3);
      assert.doesNotMatch(outputSurfaces(h) + JSON.stringify(h.progress),
        /private backend body|private network failure|private body failure|synthetic-EXA_API_KEY-secret/);
      succeeds(mode === "off" ? await h.run("web_search", { query: "fail", purpose: "All failed" })
        : await h.script(`text(await tools.web_search({query:"fail",purpose:"All failed"}));`));
      assert.equal(h.events.findLast(e => e.toolName === "web_search").structuredContent.status, "failed");
    });
  }
}

test("nested parallel batches share HTTP admission and equivalent cache misses", async t => {
  const h = await fixture(t);
  let active = 0;
  let peak = 0;
  let requests = 0;
  h.setProvider(async () => {
    requests++;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    return new Response("shared page");
  });
  succeeds(await h.script(`
    const groups=[["a","b","c"],["d","e","f"]];
    const r=await Promise.all(groups.map(g=>tools.web_fetch({urls:g.map(x=>"https://fixture.invalid/"+x)})));
    text(r.map(r=>r.results.length));
  `));
  assert.equal(requests, 6);
  assert.equal(peak, 3, "HTTP concurrency must be aggregate, not per batch");
  requests = 0;
  succeeds(await h.script(`
    const r=await Promise.all([1,2,3].map(()=>tools.web_fetch({url:"https://fixture.invalid/same"})));
    if(r.some(x=>x.results[0].content!=="shared page")) throw new Error("Missing shared page");
    text(r.length);
  `));
  assert.equal(requests, 1, "Equivalent simultaneous misses must share transport");
});

test("cached literal finding reaches omitted content without a provider request", async t => {
  const h = await fixture(t);
  const content = "界".repeat(40_000) + "Needle " + "needle ".repeat(30);
  h.setProvider(async () => new Response(content));
  succeeds(await h.script(`
    await tools.web_fetch({url:"https://fixture.invalid/find",limit:50});
    const r=await tools.web_fetch({url:"https://fixture.invalid/find",find:"NEEDLE",findCaseSensitive:false});
    const f=r.results[0].find;
    if(f.matches[0].offset!==40000 || f.count!==31 || !f.nextFrom || f.omittedMatchCount!==11)
      throw new Error("Finder contract lost");
    const missing=await tools.web_fetch({url:"https://fixture.invalid/missing",find:"test"});
    if(!missing.results[0].error) throw new Error("Cache miss must be explicit");
    text({offset:f.matches[0].offset,count:f.count});
  `));
  assert.equal(h.providerRequests.length, 1);
  validates(h, h.events.filter(e => e.toolName === "web_fetch")[1]);
});

test("cached finding never returns a Unicode match before the requested UTF-16 offset", async t => {
  const h = await fixture(t);
  h.setProvider(async () => new Response("😀😀"));
  succeeds(await h.script(`
    await tools.web_fetch({url:"https://fixture.invalid/unicode-find"});
    for(const findCaseSensitive of [true,false]) {
      const next=await tools.web_fetch({url:"https://fixture.invalid/unicode-find",find:"😀",findFrom:1,findCaseSensitive});
      if(next.results[0].find.count!==1 || next.results[0].find.matches[0].offset!==2)
        throw new Error("Match before requested UTF-16 offset");
      const end=await tools.web_fetch({url:"https://fixture.invalid/unicode-find",find:"😀",findFrom:3,findCaseSensitive});
      if(end.results[0].find.count!==0 || end.results[0].find.matches.length)
        throw new Error("Final surrogate-pair boundary repeated an earlier match");
    }
    text("bounded Unicode offsets");
  `));
  assert.equal(h.providerRequests.length, 1);
  for(const event of h.events.filter(e => e.toolName === "web_fetch")) validates(h, event);
});

test("Scout listing uses public records, stable revision and stale-page rejection", async t => {
  const h = await fixture(t);
  const now = new Date().toISOString();
  await saveState({ repos: [1, 2, 3].map(n => ({
    id: String(n), name: "duplicate", path: root, source: "https://private-token@fixture.invalid/repo",
    createdAt: now, lastSeenAt: now,
  })) });
  succeeds(await h.script(`
    const r=await tools.scout_list({limit:1});
    const next=await tools.scout_list({limit:1,offset:r.nextOffset,revision:r.revision});
    if(r.repos[0].id!=="1" || next.repos[0].id!=="2" || r.total!==3)
      throw new Error("Unstable listing");
    store("scoutRevision",r.revision);
    text(r.repos[0].id);
  `));
  assert.doesNotMatch(outputSurfaces(h), /private-token|source/);
  for (const event of h.events.filter(e => e.toolName === "scout_list")) validates(h, event);
  await saveState({ repos: [] });
  succeeds(await h.script(`
    const r=await Promise.allSettled([tools.scout_list({offset:1,revision:load("scoutRevision")})]);
    if(r[0].status!=="rejected") throw new Error("Stale page accepted");
    text((await tools.scout_list({})).total);
  `));
  assert.equal(h.gitCalls, 0);
});

test("real image backend counters remain informational rather than fabricated goal usage", async t => {
  const h = await fixture(t);
  h.setProvider(async () => new Response([
    { type: "response.output_item.done", item: { type: "image_generation_call", id: "fixture-image",
      status: "completed", result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
    { type: "response.completed", response: { id: "fixture-response", usage: { total_tokens: 999999 } } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  succeeds(await h.run("create_goal", { objective: "Fixture accounting", token_budget: 1 }));
  succeeds(await h.script(`
    const r=await tools.codex_generate_image_artifact({prompt:"fixture only",save:"none"});
    text({path:r.artifact.path});
  `));
  const image = h.events.find(e => e.toolName === "codex_generate_image_artifact");
  assert.equal(image.details.usage.total_tokens, 999999);
  assert.equal(image.usage, undefined, "unverified backend usage must not become normalized Pi usage");
  const result = await h.run("get_goal", {});
  succeeds(result);
  const state = h.events.findLast(e => e.toolName === "get_goal").structuredContent.goal;
  assert.ok(state.tokensUsed > 0 && state.tokensUsed < 1000);
  const before = state.tokensUsed;
  await h.session.reload();
  succeeds(await h.run("get_goal", {}));
  const after = h.events.findLast(e => e.toolName === "get_goal").structuredContent.goal.tokensUsed;
  assert.ok(after >= before && after - before < 100, "reload must not import backend counters");
});

for (const mode of ["off", "on", "only"]) {
  for (const excludeBash of [false, true]) {
  test(`declaration measurements and zero-budget process discovery (${mode}, excludeBash=${excludeBash})`, async t => {
    const h = await fixture(t, { mode, extra: [processes], excludeTools: excludeBash ? ["bash"] : [] });
    if (mode === "off") succeeds(await h.run("process_list", {}));
    else succeeds(await h.script(`
      const ns=await describeNamespace("processes");
      if (!ns || ns.tools.includes("bash") === ${excludeBash} || !ns.tools.includes("process_wait"))
        throw new Error("Process discovery violates exclusions");
      if (!ns.instructions.includes("acknowledge") || !ns.instructions.includes("exit_code"))
        throw new Error("Missing lifecycle instructions");
      const r=await tools.process_list({}); text({count:r.processes.length});
    `));
    const declarations = h.requests[0].tools;
    const bytes = Buffer.byteLength(JSON.stringify(declarations));
    const catalogBytes = Buffer.byteLength(declarations.find(d => d.name === "codemode")?.description ?? "");
    const coldRetainedBytes = Buffer.byteLength(JSON.stringify(h.session.messages.filter(m => m.role === "toolResult")));
    const firstUseRequests = h.requests.length;
    let discoveryOutputBytes = 0;
    if (mode !== "off") {
      const discovery = await h.script(`text(await describeNamespace("processes"));`);
      succeeds(discovery);
      discoveryOutputBytes = Buffer.byteLength(resultText(discovery));
    }
    const warmIndex = h.requests.length;
    succeeds(mode === "off" ? await h.run("process_list", {}) : await h.script(`text((await tools.process_list({})).processes.length);`));
    await h.session.reload();
    const resumedIndex = h.requests.length;
    succeeds(mode === "off" ? await h.run("process_list", {}) : await h.script(`text((await tools.process_list({})).processes.length);`));
    t.diagnostic(JSON.stringify({ mode, excludeBash, declarationBytes: bytes, catalogBytes,
      byteDerivedTokenEstimate: Math.ceil(bytes / 4), coldRetainedOutputBytes: coldRetainedBytes,
      firstUseRequests, discoveryOutputBytes,
      warmDeclarationBytes: Buffer.byteLength(JSON.stringify(h.requests[warmIndex].tools)),
      resumedDeclarationBytes: Buffer.byteLength(JSON.stringify(h.requests[resumedIndex].tools)),
      retainedOutputBytes: Buffer.byteLength(JSON.stringify(h.session.messages.filter(m => m.role === "toolResult"))),
      cacheEffects: "not measured" }));
  });
  }
}

for (const mode of ["on", "only"]) {
  test(`real codemode ${mode}: join all data surfaces without JSON.parse, then reload`, async t => {
    const h = await fixture(t, { mode });
    const result = await h.script(`
      const empty = await tools.get_goal({});
      if (empty.goal !== null) throw new Error("Expected null goal");
      const [search, libs, docs, code] = await Promise.all([
        tools.web_search({query:"fixture",purpose:"Find fixture sources"}),
        tools.library_search({libraryName:"fixture"}),
        tools.library_docs({libraryName:"fixture",query:"usage"}),
        tools.code_search({query:"fixture",purpose:"Implement fixture"})
      ]);
      const pages = await tools.web_fetch({urls: search.queries.flatMap(q => q.results.map(r => r.url))});
      if (!pages.results.every(r => typeof r.content === "string")) throw new Error("Missing page data");
      if (libs.results[0].id !== "/fixture/library" || docs.infoSnippets[0].content !== "Fixture docs") throw new Error("Missing library data");
      if (code.results[0].content !== "Fixture code") throw new Error("Missing code data");
      const added = await tools.scout_add({source:"owner/fixture"});
      const created = await tools.create_goal({objective:"Synthetic tool contract",token_budget:1});
      if (created.goal.objective !== "Synthetic tool contract") throw new Error("Missing created goal");
      text({joined:pages.results.length, library:libs.results[0].id, goal:created.goal.objective});
    `);
    succeeds(result);
    assert.match(resultText(result), /"joined":1/);
    const typed = h.events.filter(event => h.definitions.get(event.toolName)?.outputSchema && event.structuredContent);
    assert.equal(typed.length, 8, "every targeted executor must be wired into real nested dispatch");
    for (const event of typed) validates(h, event);
    assert.ok(typed.every(event => event.parentToolCallId));
    assert.equal(h.gitCalls, 1);
    assert.equal(h.events.find(event => event.toolName === "library_docs").structuredContent.rules, undefined);
    const firstNames = h.requests[0].tools.map(tool => tool.name);
    assert.ok(!firstNames.includes("web_search"), "active codemode automatically defers web schemas");
    assert.ok(firstNames.includes("update_goal") && firstNames.includes("apply_patch"));
    succeeds(await h.script(`
      const ns = await describeNamespace("scout");
      if (!ns.tools.includes("scout_rm")) throw new Error("Missing newly registered tool");
      const removed = await tools.scout_rm({idOrName:"fixture"});
      if (removed.removed.name !== "fixture" || removed.deletedClone) throw new Error("Bad removal data");
      text(removed.removed.id);
    `));
    validates(h, h.events.findLast(e => e.toolName === "scout_rm"));
    await h.session.reload();
    const restored = await h.script(`
      const g = await tools.get_goal({});
      if (g.goal.objective !== "Synthetic tool contract") throw new Error("Lost goal");
      const d = await describeTool("web_fetch");
      if (!d.includes("results")) throw new Error("Lost output schema");
      text(g.goal.status);
    `);
    succeeds(restored);
    assert.match(resultText(restored), /budget_limited/);
  });
}

test("codemode off keeps direct text, schemas, renderer details and no-goal/empty/partial data", async t => {
  const h = await fixture(t, { mode: "off" });
  for (const [name, args] of [
    ["get_goal", {}], ["web_search", { query: "empty", purpose: "Find sources" }],
    ["library_search", { libraryName: "fixture" }], ["library_docs", { libraryId: "/fixture/library", query: "usage" }],
    ["code_search", { query: "fixture", purpose: "Implement fixture" }],
    ["web_fetch", { urls: ["https://fixture.invalid/page", "https://fixture.invalid/fail"] }],
  ]) {
    const result = await h.run(name, args);
    succeeds(result);
    assert.ok(resultText(result).length > 0);
    const event = h.events.findLast(event => event.toolName === name);
    validates(h, event);
    if (name === "get_goal") assert.deepEqual(event.structuredContent, { goal: null });
    else assert.deepEqual(JSON.parse(resultText(result)), event.structuredContent);
    if (name === "web_fetch") {
      assert.equal(event.structuredContent.results[1].error, "Provider request failed (HTTP 503).");
      assert.equal(event.details.results[0].content, undefined, "renderer details stay compact");
    }
  }
  assert.ok(!h.requests[0].tools.some(tool => tool.name === "codemode"));
});

test("discovery at inline budget zero exposes awaited namespace instructions/types, not model-only tools", async t => {
  const h = await fixture(t);
  succeeds(await h.script(`
    for (const name of ["web","scout","goal","codex_images"]) {
      const ns = await describeNamespace(name);
      if (!ns?.instructions || !ns.tools.length) throw new Error("Missing namespace " + name);
    }
    const hits = await searchTools("fetch page content", {namespace:"web"});
    if (!hits.some(t => t.name === "web_fetch")) throw new Error("Missing search hit");
    const d = await describeTool("web_fetch");
    if (!d.includes("results") || !d.includes("error")) throw new Error("Missing return type");
    if (await describeTool("update_goal") || await describeTool("apply_patch") || await describeTool("codex_generate_image")) throw new Error("Model-only exposure lost");
    text("discovered");
  `));
  const description = h.requests[0].tools.find(tool => tool.name === "codemode").description;
  assert.ok(!description.includes("## web"), "native codemode does not inline deferred namespaces");
  assert.match(getCurrentSystemPrompt(h.sessionManager.buildSessionContext().messages), /await describeNamespace\("web"\)/);
  assert.ok(!description.includes("tools.web_fetch(args"), "zero inline budget omits individual signatures");
  assert.equal(h.definitions.get("update_goal").outputSchema, undefined);
  assert.equal(h.definitions.get("apply_patch").outputSchema, undefined);
  assert.equal(h.definitions.get("codex_generate_image").outputSchema, undefined);
  assert.equal(h.definitions.get("codex_generate_image_artifact").exposure, "codemode");
  assert.deepEqual(h.definitions.get("codex_generate_image_artifact").annotations,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
});

test("inactive direct tools and CLI exclusions do not become nested-callable, including reload", async t => {
  const h = await fixture(t, { codemodeEnabled: false, excludeTools: ["web_fetch", "scout_rm", "create_goal"] });
  succeeds(await h.run("scout_add", { source: "owner/fixture" }));
  h.api.setActiveTools(h.api.getActiveTools().filter(name => name !== "web_search"));
  h.setCodemode(true);
  for (const reload of [false, true]) {
    if (reload) await h.session.reload();
    const result = await h.script(`
      for (const name of ["web_search","web_fetch","scout_rm","create_goal"]) {
        if (ALL_TOOLS.some(t=>t.name===name) || await describeTool(name)) throw new Error("Leaked " + name);
      }
      try { await tools.web_fetch({url:"https://fixture.invalid/"}); throw new Error("Unexpected success"); }
      catch (e) { if (e.message === "Unexpected success") throw e; }
      text("excluded");
    `);
    succeeds(result);
  }
  assert.equal(h.events.filter(e => e.toolName === "web_fetch").length, 0);
});

test("new read-only recovery/listing tools respect exclusions across reload", async t => {
  const h = await fixture(t, { excludeTools: ["scout_list", "codex_list_image_artifacts", "process_kill"], extra: [processes] });
  for (const reload of [false, true]) {
    if (reload) await h.session.reload();
    succeeds(await h.script(`
      for(const name of ["scout_list","codex_list_image_artifacts","process_kill"]) {
        if(ALL_TOOLS.some(t=>t.name===name) || await describeTool(name)) throw new Error("Excluded tool revived");
      }
      const scout=await describeNamespace("scout");
      const images=await describeNamespace("codex_images");
      const process=await describeNamespace("processes");
      if(scout.tools.includes("scout_list") || images.tools.includes("codex_list_image_artifacts") || process.tools.includes("process_kill"))
        throw new Error("Namespace violates exclusions");
      text("excluded");
    `));
  }
  assert.equal(h.providerRequests.length, 0);
  assert.equal(h.gitCalls, 0);
});

test("defaultTools exclusions remain effective for late-registered optional research tools", async t => {
  const h = await fixture(t, { defaultTools: ["+codemode", "-library_docs", "-code_search", "-scout_rm"] });
  succeeds(await h.run("scout_add", { source: "owner/fixture" }));
  for (const reload of [false, true]) {
    if (reload) await h.session.reload();
    succeeds(await h.script(`
      if (ALL_TOOLS.some(t => ["library_docs","code_search","scout_rm"].includes(t.name))) throw new Error("Reactivated exclusion");
      text("default exclusions");
    `));
  }
});

for (const explicitlySelected of [false, true]) {
  test(`new optional tools activate when credentials arrive on reload (selected=${explicitlySelected})`, async t => {
    const previous = process.env.CONTEXT7_API_KEY;
    delete process.env.CONTEXT7_API_KEY;
    t.after(() => restoreEnv({ CONTEXT7_API_KEY: previous }));
    const h = await fixture(t, {
      defaultTools: ["+codemode", "-library_docs", ...(explicitlySelected ? ["+library_search"] : [])],
    });
    succeeds(await h.script(`
      if (await describeTool("library_search")) throw new Error("Registered without credentials");
    `));
    process.env.CONTEXT7_API_KEY = previous;
    await h.session.reload();
    for (const reload of [false, true]) {
      if (reload) await h.session.reload();
      succeeds(await h.script(`
        const r = await tools.library_search({libraryName:"fixture"});
        if (r.results[0].id !== "/fixture/library") throw new Error("Missing newly available tool");
        if (await describeTool("library_docs")) throw new Error("Lost defaultTools exclusion");
        text(r.results[0].id);
      `));
    }
    const history = h.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "pi-web-kit:registered-tools");
    assert.ok(history.length >= 2);
    assert.equal(history.at(-1).data.version, 2);
    assert.equal(history.at(-1).data.exposure, "deferred");
    assert.deepEqual(history.at(-1).data.tools, ["code_search", "library_docs", "library_search", "web_fetch", "web_search"]);
    assert.ok(h.requests.every(r => !JSON.stringify(r.input).includes("pi-web-kit:registered-tools")), "metadata stays outside model context");
  });
}

test("positive default selection does not reactivate a manually disabled research tool", async t => {
  const h = await fixture(t, { defaultTools: ["read", "+library_search"] });
  h.api.setActiveTools(h.api.getActiveTools().filter(name => name !== "library_search"));
  h.setCodemode(true);
  for (let reload = 0; reload < 2; reload++) {
    await h.session.reload();
    succeeds(await h.script(`
      if (await describeTool("library_search")) throw new Error("Reactivated manual deactivation");
      text("inactive");
    `));
  }
});

test("returning to older branch history does not revive a manually disabled tool on reload", async t => {
  const previous = process.env.CONTEXT7_API_KEY;
  delete process.env.CONTEXT7_API_KEY;
  t.after(() => restoreEnv({ CONTEXT7_API_KEY: previous }));
  const h = await fixture(t, { codemodeEnabled: false });
  const original = h.sessionManager.getBranch().find(e => e.type === "custom" && e.customType === "pi-web-kit:registered-tools");
  process.env.CONTEXT7_API_KEY = previous;
  await h.session.reload();
  await h.session.navigateTree(original.id, { summarize: false });
  assert.ok(h.session.getActiveToolNames().includes("library_search"), "new credentials make this a direct selection first");
  h.session.setActiveToolsByName([...h.session.getActiveToolNames().filter(name => name !== "library_search"), "codemode"]);
  await h.session.reload();
  succeeds(await h.script(`
    if (await describeTool("library_search")) throw new Error("Revived tool after tree navigation");
    text("inactive");
  `));
});

for (const [label, data] of [
  ["missing", undefined],
  ["legacy", { version: 1, tools: ["code_search", "library_docs", "library_search", "web_fetch", "web_search"], exposure: "direct" }],
  ["unknown version", { version: 99, tools: [] }],
  ["malformed current", { version: 2, tools: [] }],
  ["invalid names", { version: 1, tools: ["not-a-web-tool"] }],
]) {
  test(`${label} registration history preserves manual deactivation on reload`, async t => {
    const h = await fixture(t, { defaultTools: ["read", "+library_search"], withoutWebHistory: true });
    if (data) h.sessionManager.appendCustomEntry("pi-web-kit:registered-tools", data);
    h.api.setActiveTools(h.api.getActiveTools().filter(name => name !== "library_search"));
    await h.session.reload();
    assert.ok(!h.session.getActiveToolNames().includes("library_search"));
    h.setCodemode(true);
    await h.session.reload();
    succeeds(await h.script(`
      if (await describeTool("library_search")) throw new Error("Guessed activation from unknown history");
      text("inactive");
    `));
  });
}

test("CLI exclusions still win when a positively selected tool first becomes available", async t => {
  const previous = process.env.CONTEXT7_API_KEY;
  delete process.env.CONTEXT7_API_KEY;
  t.after(() => restoreEnv({ CONTEXT7_API_KEY: previous }));
  const h = await fixture(t, { defaultTools: ["+codemode", "+library_search"], excludeTools: ["library_search"] });
  process.env.CONTEXT7_API_KEY = previous;
  await h.session.reload();
  succeeds(await h.script(`
    if (await describeTool("library_search")) throw new Error("Lost CLI exclusion");
    text("excluded");
  `));
});

test("inactive Scout removal stays inactive across prompts and reload", async t => {
  const h = await fixture(t);
  succeeds(await h.run("scout_add", { source: "owner/fixture" }));
  h.api.setActiveTools(h.api.getActiveTools().filter(name => name !== "scout_rm"));
  for (const reload of [false, true]) {
    if (reload) await h.session.reload();
    succeeds(await h.script(`
      if (await describeTool("scout_rm")) throw new Error("Reactivated Scout removal");
      text("inactive");
    `));
  }
});

test("explicit deferred adapter is discoverable with budget zero and can be activated without renaming", async t => {
  const h = await fixture(t, { deferred: "web_search" });
  assert.ok(!h.api.getActiveTools().includes("web_search"));
  succeeds(await h.script(`
    const hits = await searchTools("search query", {namespace:"web"});
    if (!hits.some(t=>t.name==="web_search")) throw new Error("Undiscoverable deferred tool");
    const r = await tools.web_search({query:"fixture",purpose:"Find sources"});
    text(r.queries[0].results[0].url);
  `));
  h.api.setActiveTools([...h.api.getActiveTools(), "web_search"]);
  const direct = await h.run("web_search", { query: "fixture", purpose: "Find sources" });
  succeeds(direct);
  validates(h, h.events.findLast(e => e.toolName === "web_search"));
});

const webToolNames = ["web_search", "web_fetch", "library_search", "library_docs", "code_search"];
const serializedTools = request => [...(request.tools ?? []),
  ...(request.input ?? []).filter(item => item.type === "additional_tools").flatMap(item => item.tools ?? [])];
const activeWeb = h => h.session.getActiveToolNames().filter(name => webToolNames.includes(name)).sort();
const currentPrompt = h => getCurrentSystemPrompt(h.sessionManager.buildSessionContext().messages);
const transcriptWeb = h => getCurrentTools(h.sessionManager.buildSessionContext().messages)
  .map(tool => tool.name).filter(name => webToolNames.includes(name)).sort();
const webUnavailable = `
  for (const name of ${JSON.stringify(webToolNames)}) {
    if (await describeTool(name) || name in tools ||
        (await searchTools(name,{limit:100})).some(t=>t.name===name))
      throw new Error("Disabled web tool reachable: "+name);
  }
  text("web tools unreachable");
`;

for (const mode of ["on", "only"]) {
  test(`automatic deferred web tools preserve native discovery and activation (${mode})`, async t => {
    const h = await fixture(t, { mode });
    for (const name of webToolNames) {
      assert.equal(h.definitions.get(name).exposure, "deferred");
      assert.ok(!h.api.getActiveTools().includes(name));
    }
    succeeds(await h.script(`
      const ns=await describeNamespace("web");
      if (!ns || !ns.tools.includes("web_search")) throw new Error("Missing namespace");
      const hits=await searchTools("queries",{namespace:"web"});
      if (!hits.some(t=>t.name==="web_search")) throw new Error("Missing discovery");
      text((await tools.web_search({query:"fixture",purpose:"Test deferred registration"})).status);
    `));
    assert.ok(!serializedTools(h.requests[0]).some(tool => webToolNames.includes(tool.name)));
    assert.ok(!h.api.getActiveTools().includes("web_search"), "nested access must not activate declarations");
    const direct = await h.run("tool_search", { query: "queries", limit: 1 });
    succeeds(direct);
    assert.ok(h.api.getActiveTools().includes("web_search"));
    assert.ok(!h.api.getActiveTools().includes("web_fetch"));
    await h.session.reload();
    assert.ok(h.session.getActiveToolNames().includes("web_search"), "reload preserves explicit activation");
    assert.ok(!h.session.getActiveToolNames().includes("web_fetch"));
    succeeds(await h.script(`text((await tools.web_fetch({url:"https://fixture.invalid/page"})).results.length);`));
    assert.ok(serializedTools(h.requests.at(-1)).some(tool => tool.name === "web_search"),
      "native search explicitly declares a deferred tool in both codemode presentation modes");
  });
}

test("tool_search alone does not defer normal web interactions", async t => {
  const h = await fixture(t, { mode: "off", defaultTools: ["read", "tool_search"] });
  for (const name of webToolNames) assert.equal(h.definitions.get(name).exposure, "direct");
  succeeds(await h.run("tool_search", { query: "queries", limit: 1 }));
  assert.ok(h.api.getActiveTools().includes("web_search"));
  assert.ok(h.api.getActiveTools().includes("web_fetch"));
  succeeds(await h.run("web_search", { query: "fixture", purpose: "Direct after native discovery" }));
  assert.ok(serializedTools(h.requests.at(-1)).some(tool => tool.name === "web_search"));
});

test("registered but inactive codemode leaves web tools direct", async t => {
  const h = await fixture(t, { mode: "on", codemodeEnabled: false });
  for (const name of webToolNames) assert.equal(h.definitions.get(name).exposure, "direct");
  succeeds(await h.run("web_search", { query: "fixture", purpose: "Normal interaction" }));
  assert.ok(serializedTools(h.requests[0]).some(tool => tool.name === "web_search"));
  assert.ok(!currentPrompt(h).includes("<web_research>"));
});

test("native transcript and provider updates follow both exposure transitions without rewriting history", async t => {
  const h = await fixture(t, { mode: "on", codemodeEnabled: false });
  await h.run();
  const first = structuredClone(h.requests[0]);
  assert.deepEqual(transcriptWeb(h), [...webToolNames].sort());
  h.setCodemode(true);
  await h.run();
  assert.deepEqual(transcriptWeb(h), []);
  const deferred = h.requests.at(-1);
  if (deferred.input.some(item => item.type === "additional_tools")) {
    assert.match(JSON.stringify(deferred.input), /no longer available[\s\S]*web_search/);
  } else assert.ok(!deferred.tools.some(tool => webToolNames.includes(tool.name)));
  assert.deepEqual(h.requests[0], first, "historical direct schemas must not be rewritten");
  const hint = currentPrompt(h).match(/<web_research>([\s\S]*?)<\/web_research>/)?.[1];
  assert.ok(hint && Buffer.byteLength(hint) < 600, "bounded discovery route, not a second schema catalog");
  h.setCodemode(false);
  await h.run();
  assert.deepEqual(transcriptWeb(h), [...webToolNames].sort());
  assert.ok(!currentPrompt(h).includes("<web_research>"));
});

for (const mode of ["on", "only"]) {
  test(`automatic exposure restores manual selections and leaves unrelated tools alone (${mode})`, async t => {
    const h = await fixture(t, { mode, codemodeEnabled: false });
    h.session.setActiveToolsByName(h.session.getActiveToolNames().filter(name => name !== "library_docs" && name !== "read"));
    await h.run();
    const selected = activeWeb(h);
    assert.ok(!selected.includes("library_docs"));
    const unrelated = h.session.getActiveToolNames().filter(name => !webToolNames.includes(name) && name !== "codemode");
    for (let cycle = 0; cycle < 2; cycle++) {
      h.setCodemode(true);
      succeeds(await h.script(`
        if(await describeTool("library_docs") || "library_docs" in tools) throw new Error("Manual disable lost");
        text((await tools.web_search({query:"fixture",purpose:"Automatic exposure cycle"})).status);
      `));
      assert.equal(h.definitions.get("library_docs").exposure, "direct", "inactive direct tool must not become nested-callable");
      assert.deepEqual(activeWeb(h), []);
      assert.match(currentPrompt(h), /<web_research>/);
      assert.ok(!currentPrompt(h).match(/<web_research>[\s\S]*?library_docs[\s\S]*?<\/web_research>/));
      await h.session.reload();
      h.setCodemode(false);
      await h.run();
      assert.deepEqual(activeWeb(h), selected, "automatic undeclaration is not a manual disable");
      assert.ok(!currentPrompt(h).includes("<web_research>"));
      assert.deepEqual(h.session.getActiveToolNames().filter(name => !webToolNames.includes(name) && name !== "codemode"), unrelated);
    }
    // A deliberate native reactivation still works; the package does not hide
    // manually inactive direct tools behind an irreversible hard disable.
    h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "library_docs"]);
    h.setCodemode(true);
    succeeds(await h.script(`text((await tools.library_docs({libraryId:"/fixture/library",query:"usage"})).codeSnippets.length);`));
    h.setCodemode(false);
    await h.run();
    assert.ok(activeWeb(h).includes("library_docs"));
  });

  test(`native search activation and subsequent manual removal survive mode switches (${mode})`, async t => {
    const h = await fixture(t, { mode });
    succeeds(await h.run("tool_search", { query: "queries", limit: 1 }));
    assert.ok(activeWeb(h).includes("web_search"));
    h.session.setActiveToolsByName(h.session.getActiveToolNames().filter(name => name !== "web_search"));
    succeeds(await h.script(`
      if(await describeTool("web_search")) throw new Error("Observed manual deactivation was ignored");
      text((await tools.web_fetch({url:"https://fixture.invalid/page"})).results.length);
    `));
    await h.session.reload();
    h.setCodemode(false);
    await h.run();
    assert.deepEqual(activeWeb(h), webToolNames.filter(name => name !== "web_search").sort());
    h.setCodemode(true);
    succeeds(await h.script(`if(await describeTool("web_search")) throw new Error("Mode switch revived tool"); text("preserved");`));
  });
}

function toggleCodemodeTool(pi) {
  pi.registerTool({
    name: "fixture_toggle_codemode", label: "Fixture toggle", description: "Change only this fixture's native tool selection.",
    parameters: Type.Object({ enabled: Type.Boolean() }), outputSchema: Type.Object({ enabled: Type.Boolean() }),
    async execute(_id, { enabled }) {
      pi.setActiveTools([...pi.getActiveTools().filter(name => name !== "codemode"), ...(enabled ? ["codemode"] : [])]);
      return { content: [{ type: "text", text: "Fixture toggle" }], structuredContent: { enabled } };
    },
  });
}

test("codemode can switch off and back on inside a running script without losing permitted calls", async t => {
  const h = await fixture(t, { extra: [toggleCodemodeTool], defaultTools: ["read", "codemode", "tool_search", "-library_docs"] });
  succeeds(await h.script(`
    await tools.fixture_toggle_codemode({enabled:false});
    const page=await tools.web_fetch({url:"https://fixture.invalid/off-inside-script"});
    if(page.results.length!==1) throw new Error("Restored direct selection is not callable");
    if("library_docs" in tools) throw new Error("Explicit exclusion lost");
    await tools.fixture_toggle_codemode({enabled:true});
    text((await tools.web_search({query:"fixture",purpose:"Back in codemode"})).status);
  `));
  assert.deepEqual(activeWeb(h), []);
  succeeds(await h.run("fixture_toggle_codemode", { enabled: false }));
  assert.deepEqual(activeWeb(h), webToolNames.filter(name => name !== "library_docs").sort());
  succeeds(await h.run("web_search", { query: "fixture", purpose: "Direct call after same-run transition" }));
  succeeds(await h.run("fixture_toggle_codemode", { enabled: true }));
  assert.deepEqual(activeWeb(h), []);
  assert.ok(!h.session.getCallableToolNames().includes("library_docs"));
});

for (const disableCodemode of [false, true]) {
  test(`a late tool-call hook cannot execute a stale deferred handler (disable codemode=${disableCodemode})`, async t => {
    let armed = false;
    const h = await fixture(t, { extra: [pi => pi.on("tool_call", event => {
      if (armed && event.toolName === "web_search") {
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== "web_search" && (!disableCodemode || name !== "codemode")));
      }
    })] });
    succeeds(await h.run("tool_search", { query: "queries", limit: 1 }));
    assert.ok(activeWeb(h).includes("web_search"));
    armed = true;
    succeeds(await h.script(`
      const rejected=await Promise.allSettled([tools.web_search({query:"fixture",purpose:"Do not dispatch stale handler"})]);
      if(rejected[0].status!=="rejected") throw new Error("Selection changed after dispatch, but stale handler ran");
      text((await tools.web_fetch({url:"https://fixture.invalid/permitted-after-hook"})).results.length);
    `));
    assert.equal(h.providerRequests.length, 1);
    assert.equal(h.providerRequests[0].url, "https://markdown.new/");
    assert.ok(!h.session.getCallableToolNames().includes("web_search"));
    armed = false;
    h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "web_search"]);
    h.setCodemode(true);
    succeeds(await h.script(`text((await tools.web_search({query:"fixture",purpose:"Deliberate reactivation"})).status);`));
  });
}

test("optional tools follow the current mode when credentials disappear and return", async t => {
  const h = await fixture(t, { codemodeEnabled: false, webConfig: {} });
  h.session.setActiveToolsByName(h.session.getActiveToolNames().filter(name => name !== "library_docs"));
  await h.run();
  h.setCodemode(true);
  await h.run();
  await h.setWebConfig({ apiKeys: { exa: "", context7: "" } });
  await h.run();
  for (const name of ["library_search", "library_docs", "code_search"]) {
    assert.equal(h.definitions.get(name).exposure, "hidden");
    assert.ok(!h.session.getCallableToolNames().includes(name));
  }
  h.setCodemode(false);
  await h.run();
  assert.deepEqual(activeWeb(h), ["web_fetch", "web_search"]);
  await h.setWebConfig({});
  await h.session.reload();
  assert.deepEqual(activeWeb(h), ["code_search", "library_search", "web_fetch", "web_search"]);
  h.setCodemode(true);
  succeeds(await h.script(`
    if(await describeTool("library_docs")) throw new Error("Lost manual choice when credentials returned");
    text((await tools.library_search({libraryName:"fixture"})).results.length);
  `));
});

test("old tree restoration does not mistake pending optional tools for manual deactivation", async t => {
  const h = await fixture(t, { codemodeEnabled: false, webConfig: {} });
  h.session.setActiveToolsByName(h.session.getActiveToolNames().filter(name => name !== "library_search"));
  await h.run();
  const selected = activeWeb(h);
  const original = h.sessionManager.getLeafId();
  h.setCodemode(true);
  await h.run();
  await h.setWebConfig({ apiKeys: { context7: "" } });
  await h.run();
  assert.equal(h.definitions.get("library_docs").exposure, "hidden");
  await h.setWebConfig({});
  await h.session.navigateTree(original, { summarize: false });
  await h.run();
  assert.deepEqual(activeWeb(h), selected);
  h.setCodemode(true);
  succeeds(await h.script(`
    if(await describeTool("library_search")) throw new Error("Restoration lost the saved manual disable");
    text((await tools.library_docs({libraryId:"/fixture/library",query:"Restored pending registration"})).codeSnippets.length);
  `));
});

test("automatic exposure and manual choices survive model changes, old tree state, resume and fork", async t => {
  const h = await fixture(t, { codemodeEnabled: false,
    sessionManager: SessionManager.create(root, join(root, "automatic-exposure-sessions")) });
  h.session.setActiveToolsByName(h.session.getActiveToolNames().filter(name => name !== "library_docs"));
  await h.run();
  const directLeaf = h.sessionManager.getLeafId();
  const selected = activeWeb(h);
  h.setCodemode(true);
  succeeds(await h.script(`text((await tools.web_search({query:"fixture",purpose:"Persist deferred choice"})).status);`));
  const deferredLeaf = h.sessionManager.getLeafId();
  await h.session.setModel({ ...h.model, id: "gpt-5.6-sol" });
  succeeds(await h.script(`if(await describeTool("library_docs")) throw new Error("Model change revived tool"); text("preserved");`));
  for (const target of [directLeaf, deferredLeaf]) {
    await h.session.navigateTree(target, { summarize: false });
    h.setCodemode(true);
    succeeds(await h.script(`
      if(await describeTool("library_docs")) throw new Error("Old branch revived inactive direct tool");
      text((await tools.web_fetch({url:"https://fixture.invalid/tree-state"})).results.length);
    `));
    assert.deepEqual(activeWeb(h), []);
    h.setCodemode(false);
    await h.run();
    assert.deepEqual(activeWeb(h), selected);
  }
  h.setCodemode(true);
  await h.run();
  const file = h.sessionManager.getSessionFile();
  const fork = h.sessionManager.createBranchedSession(h.sessionManager.getLeafId());
  for (const [path, reason] of [[file, "resume"], [fork, "fork"]]) {
    const restored = await fixture(t, { sessionManager: SessionManager.open(path),
      sessionStartEvent: { type: "session_start", reason } });
    assert.deepEqual(activeWeb(restored), []);
    succeeds(await restored.script(`
      if(await describeTool("library_docs")) throw new Error("Resume/fork revived inactive tool");
      text((await tools.web_search({query:"fixture",purpose:"Restored automatic exposure"})).status);
    `));
    restored.setCodemode(false);
    await restored.run();
    assert.deepEqual(activeWeb(restored), selected);
    await restored.session.reload();
    assert.deepEqual(activeWeb(restored), selected);
    assert.ok(!currentPrompt(restored).includes("<web_research>"));
  }
});

test("hard disable and native exclusions remain effective while codemode switches both ways", async t => {
  const h = await fixture(t, { codemodeEnabled: false, excludeTools: ["web_fetch"],
    defaultTools: ["read", "tool_search", "-library_docs"], webConfig: {} });
  await h.run();
  const selected = activeWeb(h);
  assert.deepEqual(selected, ["code_search", "library_search", "web_search"]);
  for (const enabled of [false, true]) {
    await h.setWebConfig({ enabled });
    for (const codemode of [true, false, true]) {
      h.setCodemode(codemode);
      await h.run();
      const expected = enabled && !codemode ? selected : [];
      assert.deepEqual(activeWeb(h), expected);
      for (const name of ["web_fetch", "library_docs", ...(!enabled ? webToolNames : [])]) {
        assert.ok(!h.session.getCallableToolNames().includes(name));
      }
      if (!enabled) assert.ok(!currentPrompt(h).includes("<web_research>"));
    }
  }
  assert.equal(h.providerRequests.length, 0);
});

test("only newly added positive settings override a saved manual selection", async t => {
  const h = await fixture(t, { defaultTools: ["read", "tool_search", "+library_search"] });
  h.session.setActiveToolsByName(h.session.getActiveToolNames().filter(name => name !== "library_search"));
  h.setCodemode(true);
  await h.run();
  assert.ok(!h.session.getCallableToolNames().includes("library_search"));
  // A stable positive is not an instruction to undo a later manual choice.
  h.session.settingsManager.applyOverrides({ defaultTools: ["read", "tool_search", "+library_search", "+codemode"] });
  await h.run();
  assert.ok(!h.session.getCallableToolNames().includes("library_search"));
  // A new explicit selection can deliberately restore it without a new knob.
  h.session.settingsManager.applyOverrides({ defaultTools: ["read", "tool_search", "+codemode", "-library_search"] });
  await h.run();
  assert.equal(h.definitions.get("library_search").exposure, "hidden");
  h.session.settingsManager.applyOverrides({ defaultTools: ["read", "tool_search", "+codemode", "+library_search"] });
  succeeds(await h.script(`text((await tools.library_search({libraryName:"fixture"})).results.length);`));
  h.setCodemode(false);
  await h.run();
  assert.ok(activeWeb(h).includes("library_search"));
});

test("exposure metadata is bounded, outside model context, and unchanged prompts do not append it", async t => {
  const h = await fixture(t);
  const history = () => h.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "pi-web-kit:registered-tools");
  const first = structuredClone(history().at(-1).data);
  const count = history().length;
  for (let i = 0; i < 2; i++) await h.run();
  assert.equal(history().length, count);
  assert.deepEqual(history().at(-1).data, first);
  assert.deepEqual(Object.keys(first).sort(), ["declared", "directActive", "exposure", "positive", "tools", "version"]);
  for (const field of ["tools", "directActive", "declared", "positive"]) {
    assert.ok(first[field].length <= webToolNames.length);
    assert.ok(first[field].every(name => webToolNames.includes(name)));
  }
  assert.ok(h.requests.every(r => !JSON.stringify(r).includes("pi-web-kit:registered-tools")));
  assert.doesNotMatch(JSON.stringify(first), /secret|provider|apiKey|usage|credential/);
});

test("the deferred discovery section composes with unrelated and explicit full-prompt contributions", async t => {
  const marker = "Unrelated fixture instructions.";
  const h = await fixture(t, { extra: [
    pi => pi.on("before_agent_start", event => { event.systemPromptOptions.sections.fixture_context = marker; }),
  ] });
  await h.run();
  assert.match(currentPrompt(h), /<web_research>/);
  assert.ok(currentPrompt(h).includes(marker));
  h.setCodemode(false);
  await h.run();
  assert.ok(!currentPrompt(h).includes("<web_research>"));
  assert.ok(currentPrompt(h).includes(marker));
  const overridden = await fixture(t, { extra: [
    pi => pi.on("before_agent_start", () => ({ systemPrompt: "Exact fixture policy." })),
  ] });
  await overridden.run();
  const request = overridden.requests.at(-1);
  const system = [request.instructions ?? "", ...request.input.filter(item => item.type !== "additional_tools" && (item.role === "system" || item.role === "developer"))
    .map(item => typeof item.content === "string" ? item.content : item.content.map(block => block.text ?? "").join("\n"))].filter(Boolean).join("\n");
  assert.equal(system, "Exact fixture policy.", "native force/return overrides apply at provider projection");
});

test("hard-disabled web tools cannot revive by activation, credentials or reload", async t => {
  const h = await fixture(t, { webConfig: { enabled: false,
    apiKeys: { exa: "", context7: "" } } });
  for (const name of webToolNames) assert.equal(h.definitions.get(name).exposure, "hidden");
  h.api.setActiveTools([...h.api.getActiveTools(), ...webToolNames]);
  succeeds(await h.script(webUnavailable));
  succeeds(await h.run("tool_search", { query: "web search library docs code", limit: 100 }));
  succeeds(await h.script(webUnavailable));
  await h.setWebConfig({ enabled: false });
  await h.session.reload();
  succeeds(await h.script(webUnavailable));
  assert.equal(h.providerRequests.length, 0);
  // Explicit re-enabling permits discovery, not automatic direct declarations.
  await h.setWebConfig({ enabled: true });
  await h.session.reload();
  assert.ok(!h.session.getActiveToolNames().includes("web_search"));
  succeeds(await h.script(`text((await tools.web_search({query:"fixture",purpose:"Explicit re-enable"})).status);`));
});

test("switching direct to deferred withdraws prior declarations, and runtime disable blocks old handlers", async t => {
  const h = await fixture(t, { mode: "on", codemodeEnabled: false, webConfig: {} });
  assert.ok(h.api.getActiveTools().includes("web_search"));
  await h.run();
  const directLeaf = h.sessionManager.getLeafId();
  h.setCodemode(true);
  await h.run();
  assert.ok(!h.session.getActiveToolNames().includes("web_search"));
  succeeds(await h.script(`text((await tools.web_search({query:"fixture",purpose:"New deferred mode"})).status);`));
  await h.session.navigateTree(directLeaf, { summarize: false });
  h.setCodemode(true);
  succeeds(await h.script(`text((await tools.web_search({query:"fixture",purpose:"Deferred after tree navigation"})).status);`));
  assert.ok(!h.session.getActiveToolNames().includes("web_search"), "old direct tree state must not override current deferred policy");
  const oldHandler = h.definitions.get("web_search");
  const calls = h.providerRequests.length;
  await h.setWebConfig({ enabled: false });
  await assert.rejects(oldHandler.execute("stale", { query: "fixture" }, undefined, undefined,
    { cwd: root, isProjectTrusted: () => true }), /disabled/);
  succeeds(await h.script(webUnavailable));
  assert.equal(h.providerRequests.length, calls);
});

test("deferred exposure respects settings and CLI exclusions across reload", async t => {
  const h = await fixture(t, { mode: "on",
    defaultTools: ["read", "codemode", "tool_search", "-web_fetch"],
    excludeTools: ["web_search"] });
  const check = `
    for(const name of ["web_search","web_fetch"]) {
      if(await describeTool(name) || name in tools) throw new Error("Excluded tool reachable");
    }
    text(await describeTool("library_docs"));
  `;
  succeeds(await h.script(check));
  const hint = currentPrompt(h).match(/<web_research>([\s\S]*?)<\/web_research>/)?.[1];
  assert.ok(hint);
  assert.doesNotMatch(hint, /web_search|web_fetch/);
  h.api.setActiveTools([...h.api.getActiveTools(), "web_search", "web_fetch"]);
  succeeds(await h.run("tool_search", { query: "web fetch search", limit: 100 }));
  await h.session.reload();
  succeeds(await h.script(check));
  assert.equal(h.providerRequests.length, 0);
});

test("hard-disable survives old tree state, model changes, resume and fork", async t => {
  const sessions = join(root, "web-exposure-sessions");
  const h = await fixture(t, {
    sessionManager: SessionManager.create(root, sessions) });
  succeeds(await h.script(`text(await describeTool("web_search"));`));
  const beforeDisable = h.sessionManager.getLeafId();
  await h.setWebConfig({ enabled: false });
  succeeds(await h.script(webUnavailable));
  await h.session.navigateTree(beforeDisable, { summarize: false });
  succeeds(await h.script(webUnavailable));
  await h.session.setModel({ ...h.model, id: "gpt-5.6-sol" });
  succeeds(await h.script(webUnavailable));
  const file = h.sessionManager.getSessionFile();
  const fork = h.sessionManager.createBranchedSession(beforeDisable);
  for (const [path, reason] of [[file, "resume"], [fork, "fork"]]) {
    assert.ok(path);
    const restored = await fixture(t, { webConfig: { enabled: false },
      sessionManager: SessionManager.open(path), sessionStartEvent: { type: "session_start", reason } });
    succeeds(await restored.script(webUnavailable));
    succeeds(await restored.run("tool_search", { query: "web search library docs code", limit: 100 }));
    succeeds(await restored.script(webUnavailable));
    assert.equal(restored.providerRequests.length, 0);
  }
  assert.equal(h.providerRequests.length, 0);
});

test("errors reject, fetch failures remain data, and all output surfaces exclude credentials/raw metadata", async t => {
  const h = await fixture(t);
  h.setProvider(async (url) => {
    if (String(url) === "https://api.exa.ai/search") return json({ results: [{
      title: "synthetic-EXA_API_KEY-secret",
      url: "https://origin-user:origin-password@fixture.invalid/page?token=origin-token",
      text: "Authorization: Bearer auth-header-secret",
      arbitrary: { cacheKey: "private-cache", responseBody: "private-body" },
    }] });
    return new Response("raw-backend-secret synthetic-CONTEXT7_API_KEY-secret", { status: 401 });
  });
  succeeds(await h.script(`
    const r = await tools.web_search({query:"fixture",purpose:"Find sources"});
    if (r.queries[0].results[0].title.includes("synthetic")) throw new Error("Secret leak");
    const failures = await tools.web_fetch({urls:["https://fixture.invalid/fail"]});
    if (!failures.results[0].error) throw new Error("Expected per-item failure");
    const results = await Promise.allSettled([
      tools.library_search({libraryName:"fixture"}),
      tools.create_goal({objective:""}),
      tools.web_fetch({url:"https://user:origin-password@fixture.invalid"})
    ]);
    if (!results.every(r=>r.status==="rejected")) throw new Error("Failures did not reject");
    text(results.map(r=>r.reason.message));
  `));
  const serialized = outputSurfaces(h);
  assert.doesNotMatch(serialized, /raw-backend-secret|auth-header-secret|origin-user|origin-password|origin-token|private-cache|private-body|synthetic-EXA_API_KEY-secret/);
  for (const event of h.events.filter(e => e.structuredContent)) validates(h, event);
});

test("progress and per-page backend errors are sanitized through the registered tool", async t => {
  const previous = process.env.PI_WEB_KIT_PROVIDER_FETCH;
  process.env.PI_WEB_KIT_PROVIDER_FETCH = "tinyfish";
  t.after(() => restoreEnv({ PI_WEB_KIT_PROVIDER_FETCH: previous }));
  const h = await fixture(t, { mode: "off" });
  h.setProvider(async () => json({ errors: [{ url: "https://fixture.invalid/?token=private-url-secret",
    error: "private-backend-body", status: "private-status" }] }));
  const result = await h.run("web_fetch", { url: "https://fixture.invalid/?token=private-url-secret" });
  succeeds(result);
  assert.equal(h.events.findLast(e => e.toolName === "web_fetch").structuredContent.results[0].error, "Provider could not fetch this page.");
  assert.ok(h.progress.length > 0);
  assert.doesNotMatch(outputSurfaces(h) + JSON.stringify(h.progress), /private-url-secret|private-backend-body|private-status/);
  validates(h, h.events.findLast(e => e.toolName === "web_fetch"));
});

test("nested research keeps auth prose but masks real header values in every result surface", async t => {
  const h = await fixture(t);
  h.setProvider(async () => json({
    results: [{ url: "https://fixture.invalid/auth", highlights: ['Basic authentication uses a Bearer token.\nAuthorization: Basic YWJj\n"authorization": "Bearer x"'] }],
  }));
  succeeds(await h.script(`
    const r = await tools.code_search({query:"HTTP authentication",purpose:"Implement authentication"});
    const content = r.results[0].content;
    if (!content.includes("Basic authentication uses a Bearer token.")) throw new Error("Redacted ordinary prose");
    if (content.includes("YWJj") || content.includes("Bearer x")) throw new Error("Leaked header credential");
    text(content);
  `));
  assert.match(outputSurfaces(h), /Basic authentication uses a Bearer token/);
  assert.doesNotMatch(outputSurfaces(h), /YWJj|Bearer x/);
  validates(h, h.events.findLast(e => e.toolName === "code_search"));
});

test("cancellation aborts the provider and never publishes a structured success", { timeout: 10_000 }, async t => {
  const h = await fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let providerSignal;
  h.setProvider(async (_url, init) => {
    providerSignal = init.signal;
    entered();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("Synthetic provider aborted")), { once: true });
    });
  });
  const running = h.script('text(await tools.web_fetch({url:"https://fixture.invalid/cancel"}));');
  await started;
  await h.session.abort();
  const result = await running;
  assert.equal(providerSignal.aborted, true);
  assert.equal(result.isError, true);
  assert.ok(!h.events.some(e => e.toolName === "web_fetch" && e.structuredContent));
});

test("normal approval and result-redaction hooks cover nested structured calls", async t => {
  const h = await fixture(t, { extra: [pi => {
    pi.on("tool_call", event => {
      if (event.toolName === "web_search" && event.input.query === "blocked") return { block: true, reason: "Synthetic approval denied" };
    });
    pi.on("tool_result", event => {
      if (event.toolName === "code_search") return { content: [{ type: "text", text: "Redacted by policy" }], structuredContent: { response: "policy-safe" } };
      if (event.toolName === "library_search") return { content: [{ type: "text", text: "Text-only policy" }] };
    });
  }] });
  succeeds(await h.script(`
    const r = await tools.code_search({query:"fixture",purpose:"Implement fixture"});
    if (r.response !== "policy-safe") throw new Error("Structured redaction bypass");
    try { await tools.web_search({query:"blocked",purpose:"Find sources"}); throw new Error("Approval bypass"); }
    catch (e) { if (!e.message.includes("Synthetic approval denied")) throw e; }
    // Pi drops stale structuredContent when a later hook replaces only text.
    try {
      const l = await tools.library_search({libraryName:"fixture"});
      if (l?.results) throw new Error("Text-only redaction bypass");
    } catch (e) { if (e.message === "Text-only redaction bypass") throw e; }
    text("policy boundaries retained");
  `));
});

test("parallel reads overlap; Scout mutations serialize, omit origin credentials and return missing-target data", async t => {
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let arrived = 0;
  let gitActive = 0;
  let gitPeak = 0;
  const h = await fixture(t, { git: async () => {
    gitActive++;
    gitPeak = Math.max(gitPeak, gitActive);
    await new Promise(resolve => setImmediate(resolve));
    gitActive--;
    return { code: 0, stdout: "", stderr: "" };
  } });
  h.setProvider(async () => {
    active++;
    peak = Math.max(peak, active);
    if (++arrived === 2) release();
    await gate;
    active--;
    return json({ results: [] });
  });
  const result = await h.script(`
    await Promise.all([tools.web_search({query:"one",purpose:"Find sources"}),tools.web_search({query:"two",purpose:"Find sources"})]);
    const repos = await Promise.all([
      tools.scout_add({source:"https://fixture-user:fixture-password@fixture.invalid/one.git"}),
      tools.scout_add({source:"owner/two"})
    ]);
    if (repos.some(r=>r.repo.source)) throw new Error("Origin escaped");
    text(repos.map(r=>r.repo.name));
  `);
  succeeds(result);
  succeeds(await h.script(`
    const missing = await tools.scout_rm({idOrName:"not-present"});
    if (missing.removed !== null || missing.deletedClone) throw new Error("Missing target contract");
    for (const name of ["one","two"]) await tools.scout_rm({idOrName:name,deleteClone:true});
    text("ordered mutations");
  `));
  assert.equal(peak, 2);
  assert.equal(gitPeak, 1);
  assert.doesNotMatch(outputSurfaces(h), /fixture-password|fixture-user/);
  for (const event of h.events.filter(e => e.structuredContent)) validates(h, event);
});

test("failed Scout clones expose bounded diagnostics, not Git stderr", async t => {
  const h = await fixture(t, { git: async () => ({ code: 128, stderr: "private Git origin credential".repeat(2000), stdout: "" }) });
  const result = await h.run("scout_add", { source: "owner/fixture" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /Git clone failed \(exit code 128\)/);
  assert.doesNotMatch(resultText(result), /private Git origin/);
  assert.ok(resultText(result).length < 200);
});

test.after(async () => {
  try { await rm(root, { recursive: true, force: true }); }
  finally { restoreEnv(savedEnv); }
});
