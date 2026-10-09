import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { codexHarness, requestBody, textResponse } from "./codex-harness.mjs";

// No user profiles, credentials, Git remotes or provider requests.
const root = await mkdtemp(join(tmpdir(), "pi-structured-tools-"));
const envOverrides = {
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
async function fixture(t, { mode = "only", inlineBudget = 0, defaultTools, excludeTools, deferred, extra = [], git } = {}) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network blocked"); });
  await mkdir(process.env.PI_SCOUT_TMPDIR, { recursive: true });
  await saveState({ repos: [] });
  fetchCache.clear();
  const definitions = new Map();
  const events = [];
  const progress = [];
  const requests = [];
  let gitCalls = 0;
  const capture = extension => pi => extension({
    ...pi,
    registerTool(tool) {
      // Explicit opt-in adapter only in this test: production exposure remains direct.
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
  ], { cwd: root, defaultTools: defaultTools ?? (mode === "off" ? ["read"] : ["read", "codemode", "tool_search"]), excludeTools });
  t.after(() => h.close());
  h.session.subscribe(event => {
    if (event.type === "tool_execution_update") progress.push(event.partialResult);
  });
  let next;
  let provider = async (url, init) => {
    const target = String(url);
    if (target === "https://api.exa.ai/search") {
      const { query } = JSON.parse(init.body);
      return json({ results: query === "empty" ? [] : [{ title: "Fixture", url: "https://fixture.invalid/page", text: "bounded page context" }] });
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
    if (target === "https://api.exa.ai/context") return json({ query: "fixture", response: "Fixture code" });
    throw new Error("Unmocked provider URL");
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/codex/responses")) {
      const request = requestBody(init);
      requests.push(request);
      if (requests.length > 30) throw new Error("Fixture exceeded bounded model requests");
      if (!next) return textResponse();
      const call = next;
      next = undefined;
      return responseFor(request, ...call);
    }
    return provider(url, init);
  };
  return {
    ...h, definitions, events, requests, progress,
    get gitCalls() { return gitCalls; },
    setProvider(value) { provider = value; },
    async run(name, args) {
      next = [name, args];
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

for (const mode of ["on", "only"]) {
  test(`real codemode ${mode}: join all data surfaces without JSON.parse, then reload`, async t => {
    const h = await fixture(t, { mode });
    const result = await h.script(`
      const empty = await tools.get_goal({});
      if (empty.goal !== null) throw new Error("Expected null goal");
      const [search, libs, docs, code] = await Promise.all([
        tools.web_search({query:"fixture"}),
        tools.library_search({libraryName:"fixture"}),
        tools.library_docs({libraryName:"fixture",query:"usage"}),
        tools.code_search({query:"fixture"})
      ]);
      const pages = await tools.web_fetch({urls: search.queries.flatMap(q => q.results.map(r => r.url))});
      if (!pages.results.every(r => typeof r.content === "string")) throw new Error("Missing page data");
      if (libs.results[0].id !== "/fixture/library" || docs.infoSnippets[0].content !== "Fixture docs") throw new Error("Missing library data");
      if (code.response !== "Fixture code") throw new Error("Missing code data");
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
    assert.equal(firstNames.includes("web_search"), mode === "on");
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
    ["get_goal", {}], ["web_search", { query: "empty" }],
    ["library_search", { libraryName: "fixture" }], ["library_docs", { libraryId: "/fixture/library", query: "usage" }],
    ["code_search", { query: "fixture" }],
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
  assert.match(description, /web/);
  assert.ok(!description.includes("tools.web_fetch(args"), "zero inline budget omits individual signatures");
  assert.equal(h.definitions.get("update_goal").outputSchema, undefined);
  assert.equal(h.definitions.get("apply_patch").outputSchema, undefined);
  assert.equal(h.definitions.get("codex_generate_image").outputSchema, undefined);
  assert.equal(h.definitions.get("codex_generate_image_artifact").exposure, "codemode");
  assert.deepEqual(h.definitions.get("codex_generate_image_artifact").annotations,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
});

test("inactive direct tools and CLI exclusions do not become nested-callable, including reload", async t => {
  const h = await fixture(t, { excludeTools: ["web_fetch", "scout_rm", "create_goal"] });
  succeeds(await h.run("scout_add", { source: "owner/fixture" }));
  h.api.setActiveTools(h.api.getActiveTools().filter(name => name !== "web_search"));
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
    const r = await tools.web_search({query:"fixture"});
    text(r.queries[0].results[0].url);
  `));
  h.api.setActiveTools([...h.api.getActiveTools(), "web_search"]);
  const direct = await h.run("web_search", { query: "fixture" });
  succeeds(direct);
  validates(h, h.events.findLast(e => e.toolName === "web_search"));
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
    const r = await tools.web_search({query:"fixture"});
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
  const h = await fixture(t);
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
    response: 'Basic authentication uses a Bearer token.\nAuthorization: Basic YWJj\n"authorization": "Bearer x"',
  }));
  succeeds(await h.script(`
    const r = await tools.code_search({query:"HTTP authentication"});
    if (!r.response.includes("Basic authentication uses a Bearer token.")) throw new Error("Redacted ordinary prose");
    if (r.response.includes("YWJj") || r.response.includes("Bearer x")) throw new Error("Leaked header credential");
    text(r.response);
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
    const r = await tools.code_search({query:"fixture"});
    if (r.response !== "policy-safe") throw new Error("Structured redaction bypass");
    try { await tools.web_search({query:"blocked"}); throw new Error("Approval bypass"); }
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
    await Promise.all([tools.web_search({query:"one"}),tools.web_search({query:"two"})]);
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
