import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const repo = process.cwd();
const reference = process.env.PI_WEB_ACCESS_REFERENCE;
if (!reference) throw new Error("Set PI_WEB_ACCESS_REFERENCE to the read-only pi-web-access reference checkout.");
assert.equal(execFileSync("git", ["-C", reference, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  "9e276ddc70f4a9c8f63ebfff9897fc1ce5d75362", "Reference checkout must match the evaluated revision.");
// Optional disposable lane. Never change the working repository's dependency inputs.
const requestedHost = process.argv[2];
if (requestedHost) {
  assert.ok(["1.1.0", "1.4.0"].includes(requestedHost), "Expected Pi 1.1.0 or 1.4.0.");
  const dir = await mkdtemp(join(tmpdir(), "pi-decisions-host-"));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: dir, stdio: "inherit", timeout: 600_000,
      env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_TEST_HOST_VERSION: requestedHost, PI_TEST_HOST_ROOT: dir } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} failed`);
  };
  try {
    await cp(repo, dir, { recursive: true, filter: path =>
      !["node_modules", ".git", ".pi", ".test-dist", "pi-compound-engineering"].includes(basename(path)) });
    const manifestPath = join(dir, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.devDependencies = Object.fromEntries(["pi-ai", "pi-coding-agent", "pi-tui"].map(n => [`@earendil-works/${n}`, requestedHost]));
    await writeFile(manifestPath, JSON.stringify(manifest));
    for (const entry of await readdir(join(dir, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, "packages", entry.name, "package.json");
      const pkg = JSON.parse(await readFile(path, "utf8"));
      for (const name of Object.keys(pkg.devDependencies ?? {})) {
        if (name.startsWith("@earendil-works/pi-")) pkg.devDependencies[name] = requestedHost;
      }
      await writeFile(path, JSON.stringify(pkg));
    }
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    run(process.execPath, ["--import", "tsx", "docs/research/eval-codemode-decisions.mjs"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
  process.exit(0);
}
const root = await mkdtemp(join(tmpdir(), "pi-d123-"));
Object.assign(process.env, {
  HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_SCOUT_TMPDIR: join(root, "scout"),
  CI: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
  EXA_API_KEY: "synthetic-exa", CONTEXT7_API_KEY: "synthetic-context7",
  TINYFISH_API_KEY: "synthetic-tinyfish", FIRECRAWL_API_KEY: "synthetic-firecrawl", BRAVE_SEARCH_API_KEY: "synthetic-brave",
  PI_WEB_KIT_PROVIDER_SEARCH: "exa", PI_WEB_KIT_PROVIDER_FETCH: "markdown_new",
});
const imp = p => import(pathToFileURL(resolve(repo, p)).href);
const { codexHarness, requestBody, textResponse, hostVersion } = await imp("tests/codex-harness.mjs");
const { createCodemodeExtension, createToolSearchExtension } = await imp("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { default: web } = await imp("packages/pi-web-kit/extensions/index.ts");
const { default: processes } = await imp("packages/pi-processes/extensions/index.ts");
const { default: images } = await imp("packages/pi-codex-image-gen/extensions/index.ts");
const { default: scout } = await imp("packages/pi-scout/extensions/index.ts");
const webNames = ["web_search", "web_fetch", "library_search", "library_docs", "code_search"];
const originalFetch = globalThis.fetch;
const bytes = x => Buffer.byteLength(typeof x === "string" ? x : JSON.stringify(x));
// Pi 1.1 uses top-level tools plus chronological additions; 1.4 uses additions.
const catalog = request => [...new Map([...request.tools,
  ...(request.input ?? []).filter(i => i.type === "additional_tools").flatMap(i => i.tools ?? [])]
  .map(tool => [tool.name, tool])).values()];
let sequence = 0;
function callResponse(request, name, args) {
  const custom = request.tools.find(t => t.name === name)?.type === "custom";
  const id = `eval_${++sequence}`;
  const item = custom
    ? { type: "custom_tool_call", id: `ct_${id}`, call_id: id, name, input: args }
    : { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(name === "codemode" ? { code: args } : args) };
  return new Response([
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(custom ? { input: "" } : { arguments: "" }) } },
    { type: custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
      output_index: 0, item_id: item.id, delta: custom ? item.input : item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const configurations = [
  { name: "direct-off", mode: "off" },
  { name: "direct-on-3000", mode: "on", budget: 3000 },
  { name: "direct-on-0", mode: "on", budget: 0 },
  { name: "direct-only-0", mode: "only", budget: 0 },
  { name: "web-deferred-on-3000", mode: "on", budget: 3000, defer: true },
  { name: "web-deferred-on-0", mode: "on", budget: 0, defer: true },
  { name: "web-deferred-off-search", mode: "off", defer: true },
  { name: "web-hidden-on-0", mode: "on", budget: 0, hidden: true, negative: true },
  { name: "web-deferred-excluded-on-0", mode: "on", budget: 0, defer: true, excluded: true, negative: true },
];
const d1 = [];
try {
  for (const config of configurations) {
    const requests = [];
    let next;
    let http = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/codex/responses")) {
        const request = requestBody(init);
        requests.push(request);
        const call = next;
        next = undefined;
        return call ? callResponse(request, ...call) : textResponse();
      }
      if (String(url) === "https://api.exa.ai/search") {
        http++;
        return Response.json({ results: [{ title: "Synthetic", url: "https://example.com", highlights: ["Synthetic public fixture."] }] });
      }
      throw new Error(`Unmocked request blocked: ${new URL(String(url)).origin}`);
    };
    const adapt = pi => web({ ...pi, registerTool: tool => pi.registerTool({
      ...tool, ...(webNames.includes(tool.name) && (config.defer || config.hidden) ? { exposure: config.hidden ? "hidden" : "deferred" } : {}),
    }) });
    const h = await codexHarness([
      ...(config.mode === "off" ? [] : [createCodemodeExtension({ mode: config.mode, inlineBudget: config.budget })]),
      createToolSearchExtension(), adapt, processes, scout, images,
    ], { cwd: root, ...(config.excluded ? { excludeTools: ["web_search"] } : {}),
      defaultTools: ["read", "write", "edit", "bash", "tool_search", ...(config.mode === "off" ? [] : ["codemode"])] });
    const run = async (name, args) => {
      next = name ? [name, args] : undefined;
      await h.session.prompt("Synthetic offline research fixture.");
      assert.deepEqual(h.errors, []);
      const result = h.session.messages.findLast(m => m.role === "toolResult");
      assert.ok(!result?.isError, JSON.stringify(result));
      return result;
    };
    try {
      await run();
      const cold = requests.at(-1);
      let discoveryBytes = 0;
      const unavailable = 'if (await describeTool("web_search") || (await searchTools("web search",{limit:100})).some(t=>t.name==="web_search")) throw new Error("Disabled tool was discoverable"); if ("web_search" in tools) throw new Error("Disabled tool was callable"); text("unreachable");';
      if (config.negative) {
        if (config.hidden) h.api.setActiveTools([...h.api.getActiveTools(), "web_search"]);
        await run("codemode", unavailable);
        await h.session.reload();
        await run("codemode", unavailable);
      }
      else if (config.mode !== "off") {
        const result = await run("codemode", 'const t=await searchTools("web search",{limit:1}); text(t); text(await describeTool("web_search"));');
        discoveryBytes = bytes(result.content);
      } else if (config.defer) {
        const result = await run("tool_search", { query: "queries", limit: 1 });
        discoveryBytes = bytes(result.content);
        assert.ok(h.api.getActiveTools().includes("web_search"), "tool_search must activate web_search before its direct call");
      }
      const firstIndex = requests.length;
      const args = { query: "synthetic research", purpose: "Offline fixture only." };
      if (config.negative) await run("codemode", unavailable);
      else await run(config.mode === "off" ? "web_search" : "codemode",
          config.mode === "off" ? args : `text((await tools.web_search(${JSON.stringify(args)})).queries[0].results.length);`);
      const warm = requests[firstIndex];
      assert.equal(http, config.negative ? 0 : 1);
      const row = {
        ...config, hostVersion, coldDeclarationsBytes: bytes(catalog(cold)),
        coldWebDeclared: catalog(cold).filter(t => webNames.includes(t.name)).map(t => t.name),
        coldCoreDeclared: catalog(cold).filter(t => ["read", "edit", "write", "bash"].includes(t.name)).map(t => t.name),
        coldCodemodeDescriptionBytes: bytes(cold.tools.find(t => t.name === "codemode")?.description ?? ""),
        discoveryOutputBytes: discoveryBytes, warmDeclarationsBytes: bytes(catalog(warm)),
        retainedToolOutputBytes: bytes(h.session.messages.filter(m => m.role === "toolResult")),
        providerRequests: http, serializerOnly: true,
        warmWebDeclared: catalog(warm).filter(t => webNames.includes(t.name)).map(t => t.name),
        warmAdditionalWebDeclared: (warm.input ?? []).filter(i => i.type === "additional_tools").flatMap(i => i.tools ?? []).filter(t => webNames.includes(t.name)).map(t => t.name),
      };
      d1.push(row);
      console.log("D1", JSON.stringify(row));
    } finally { await h.close(); }
  }
  const { extractPageFields, parseExtractFields } = await import(pathToFileURL(join(reference, "field-extract.ts")));
  const context = { modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "synthetic" }, env: { CLOUDFLARE_ACCOUNT_ID: "synthetic" } }) } };
  const probes = [
    { name: "wrong-plan-number", page: "Starter costs $9/month. Pro costs $24/month.", field: { type: "number", instructions: "Pro monthly price" }, answer: { value: 9, confidence: .99 }, expected: 24 },
    { name: "wrong-release-text", page: "Beta: v6.0.0. Stable: v5.3.1.", field: { type: "text", instructions: "Latest stable release" }, answer: { value: "v6.0.0", confidence: .99 }, expected: "v5.3.1" },
    { name: "invented-date", page: "Release date has not been announced.", field: { type: "date" }, answer: { value: "2026-11-01", confidence: .99 }, expected: null },
    { name: "missing-text-control", page: "Price $24/month.", field: { type: "text" }, answer: { value: "Made up", confidence: .99 }, expected: null },
    { name: "low-confidence-control", page: "Pro $24/month.", field: { type: "number" }, answer: { value: 24, confidence: .4 }, expected: 24 },
    { name: "null-control", page: "Enterprise: contact sales.", field: { type: "number" }, answer: { value: null, guess: 9, confidence: .99 }, expected: null },
  ];
  const d2 = [];
  for (const probe of probes) {
    globalThis.fetch = async url => {
      assert.equal(new URL(url).origin, "https://api.cloudflare.com");
      return Response.json({ success: true, result: { answers: { target: probe.answer } } });
    };
    const result = await extractPageFields(probe.page, { target: probe.field }, context, undefined, "2026-10-24");
    assert.ok(result.fields);
    d2.push({ name: probe.name, result: result.fields.target, expected: probe.expected,
      acceptedWrong: result.fields.target.status === "extracted" && result.fields.target.value !== probe.expected });
  }
  assert.equal(d2.filter(p => p.acceptedWrong).length, 3);
  const sets = [];
  for (const name of ["calibration", "holdout"]) {
    const pages = JSON.parse(await readFile(join(reference, "eval/fixtures", `extract-${name}.json`), "utf8"));
    const values = pages.flatMap(p => Object.values(p.expected));
    const full = pages.map(p => ({ page: p.page }));
    // Oracle output is a size lower bound, NOT measured model output or accuracy.
    const oracle = pages.map(p => ({ fields: Object.fromEntries(Object.entries(p.expected).map(([k, v]) =>
      [k, v === null ? { status: "missing" } : { status: "extracted", value: v }])) }));
    const projectedOracle = [];
    for (const page of pages) {
      globalThis.fetch = async () => Response.json({ success: true, result: { answers: Object.fromEntries(
        Object.entries(page.expected).map(([k, value]) => [k, { value, confidence: .99 }])) } });
      const specs = parseExtractFields(Object.fromEntries(Object.entries(page.fields).map(([k, f]) =>
        [k, f.instructions ? `${f.type}: ${f.instructions}` : f.type])));
      projectedOracle.push(await extractPageFields(page.page, specs, context, undefined, page.referenceDate));
    }
    sets.push({ name, pages: pages.length, fields: values.length, missing: values.filter(v => v === null).length,
      fullPageJsonBytes: bytes(full), oracleTypedJsonBytes: bytes(oracle),
      oracleWithReferenceMetadataJsonBytes: bytes(projectedOracle),
      fieldTypes: pages.flatMap(p => Object.values(p.fields).map(f => f.type)),
      sourceBytes: pages.reduce((n,p) => n + bytes(p.page), 0) });
  }
  console.log("D2", JSON.stringify({ probes: d2, sets }));
  const { fetchWithCache } = await imp("packages/pi-web-kit/src/fetch.ts");
  const { fetchCache } = await imp("packages/pi-web-kit/src/cache.ts");
  const source = JSON.parse(await readFile(join(reference, "eval/fixtures/extract-holdout.json"), "utf8"))[0];
  const longPage = "# Background\n\n".concat("Background information unrelated to subscription plans.\n".repeat(2000), source.page);
  let pageRequests = 0;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://markdown.new/");
    pageRequests++;
    return new Response(longPage, { headers: { "content-type": "text/markdown" } });
  };
  fetchCache.clear();
  const config = { provider_search: "exa", provider_fetch: "markdown_new", apiKeys: { EXA_API_KEY: "synthetic-exa" },
    markdownNew: { method: "auto", retainImages: false } };
  const urls = ["https://example.com/pricing"];
  const initial = await fetchWithCache("markdown_new", { limit: 1000 }, urls, undefined, config);
  const found = await fetchWithCache("markdown_new", { find: "## Pro" }, urls, undefined, config);
  assert.equal(pageRequests, 1);
  assert.equal(found.results[0].find.count, 1);
  assert.ok(found.results[0].find.matches[0].excerpt.includes("$24/month"));
  const finder = { sourceBytes: bytes(longPage), initialResultJsonBytes: bytes(initial),
    finderResultJsonBytes: bytes(found), providerRequests: pageRequests, excerpt: found.results[0].find.matches[0].excerpt };
  console.log("D2_FINDER", JSON.stringify(finder));
  const { parseCodexSse } = await imp("packages/pi-codex-image-gen/src/codex-response.ts");
  const d3 = [];
  for (const fixture of [
    { name: "complete-routing-usage", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 10 } } },
    { name: "total-only", usage: { total_tokens: 120 } },
    { name: "no-usage" },
    { name: "tool-image-usage", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      tool_usage: { image_gen: { input_tokens: 500, output_tokens: 1000, total_tokens: 1500 } } },
    { name: "inconsistent-usage", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 3 } },
  ]) {
    const image = { type: "image_generation_call", id: "ig_fixture", status: "completed", result: "aW1hZ2U=" };
    const response = new Response(`data: ${JSON.stringify({ type: "response.completed", response: { ...fixture, output: [image] } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
    const parsed = await parseCodexSse(response, new AbortController().signal, []);
    d3.push({ name: fixture.name, supplied: fixture, retainedUsage: parsed.usage ?? null });
  }
  console.log("D3", JSON.stringify(d3));
  const results = { d1, d2: { probes: d2, sets, finder }, d3 };
  if (process.env.PI_DECISIONS_OUTPUT) await writeFile(process.env.PI_DECISIONS_OUTPUT, JSON.stringify(results, null, 2), { flag: "wx", mode: 0o600 });
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
