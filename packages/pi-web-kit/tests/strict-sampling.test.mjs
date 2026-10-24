import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import extension from "../extensions/index.ts";

// Use the pinned SDK by default; optionally repeat against an installed host.
// PI_WEB_KIT_TEST_RUNTIME is the directory containing the @earendil-works packages.
const runtimeRoot = process.env.PI_WEB_KIT_TEST_RUNTIME;
const fromRuntime = name => runtimeRoot
  ? pathToFileURL(resolve(runtimeRoot, name, "dist/index.js")).href
  : `@earendil-works/${name}`;
const { InMemoryCredentialStore } = await import(fromRuntime("pi-ai"));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(fromRuntime("pi-coding-agent"));

const toolCall = (name, args) => ({
  type: "function_call", id: `fc_${name}`, call_id: `call_${name}`,
  name, arguments: JSON.stringify(args), status: "completed",
});
const answer = {
  type: "message", id: "msg_done", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "done", annotations: [] }],
};

function response(output) {
  const events = [{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } }];
  for (const [output_index, item] of output.entries()) {
    events.push({ type: "response.output_item.added", output_index,
      item: item.type === "message" ? { ...item, content: [] } : item });
    events.push({ type: "response.output_item.done", output_index, item });
  }
  events.push({ type: "response.completed", response: {
    id: "resp_fixture", status: "completed", output: [],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

async function harness(t, supportsStrictMode, provider = "openai") {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-kit-strict-"));
  const saved = { ...process.env };
  Object.assign(process.env, {
    PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: dir,
    CONTEXT7_API_KEY: "synthetic-context7-key",
  });
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network blocked"); });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider, async () => ({ type: "api_key", key: "sk-synthetic-provider-key" }));
  const runtime = await ModelRuntime.create({
    credentials, modelsPath: null, modelsStorePath: join(dir, "models.json"),
  });
  const api = provider === "openai" ? "openai-responses" : "anthropic-messages";
  const catalogModel = runtime.getModels(provider).find(model => model.api === api);
  assert.ok(catalogModel, `offline catalog must have a ${provider} model`);
  const model = { ...catalogModel, compat: {
    ...catalogModel.compat, supportsStrictMode, supportsStrictTools: supportsStrictMode,
    supportsAdditionalTools: true, supportsMidConvoSystemMessages: true,
  } };
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["library_search", "library_docs"],
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "You are a test assistant.",
    extensionFactories: [extension],
  });
  await loader.reload();
  const errors = [];
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, model, modelRuntime: runtime, settingsManager,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), thinkingLevel: "off",
    excludeTools: ["web_search", "web_fetch", "code_search"],
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  assert.deepEqual(session.getActiveToolNames().sort(), ["library_docs", "library_search"]);
  return { session, errors };
}

test("real Pi falls back for Anthropic's unsupported strict numeric bounds", async t => {
  const h = await harness(t, true, "anthropic");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(String(url)).hostname, "api.anthropic.com");
    requests.push(JSON.parse(init.body));
    const events = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant",
        model: "fixture", content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  });
  await h.session.prompt("Say done.");
  assert.equal(requests.length, 1);
  for (const name of ["library_search", "library_docs"]) {
    const tool = requests[0].tools.find(tool => tool.name === name);
    assert.ok(tool);
    assert.notEqual(tool.strict, true);
    assert.equal(tool.input_schema.properties.limit.minimum, 1);
    assert.equal(tool.input_schema.properties.limit.maximum, 20);
  }
  assert.equal(h.session.getLastAssistantText(), "done");
  assert.deepEqual(h.errors, []);
});

function declaredTools(payload) {
  return [...(payload.tools ?? []),
    ...payload.input.flatMap(item => item.type === "additional_tools" ? item.tools : [])];
}

for (const supportsStrictMode of [true, false]) {
  test(`real Pi keeps Context7 optional arguments and defaults with strict support ${supportsStrictMode}`, async t => {
    const h = await harness(t, supportsStrictMode);
    const requests = [];
    const contextRequests = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const target = new URL(String(url));
      if (target.hostname === "api.openai.com") {
        requests.push(JSON.parse(init.body));
        assert.ok(requests.length <= 2, "unexpected model continuation");
        return response(requests.length === 1 ? [
          toolCall("library_search", { libraryName: "fixture", query: null, fast: null, limit: null }),
          toolCall("library_docs", {
            libraryId: null, libraryName: "fixture", query: "docs question",
            version: null, fast: null, limit: null,
          }),
        ] : [answer]);
      }
      assert.equal(target.hostname, "context7.com");
      contextRequests.push(target);
      assert.equal(target.searchParams.has("limit"), false, "limit is local, not a provider parameter");
      assert.equal(target.searchParams.get("fast"), "false", "optional null must preserve default reranking");
      if (target.pathname.endsWith("/libs/search")) {
        return new Response(JSON.stringify({
          results: Array.from({ length: 12 }, (_, i) => ({ id: `/fixture/lib${i}`, title: `Library ${i}` })),
        }));
      }
      assert.equal(target.pathname, "/api/v2/context");
      assert.equal(target.searchParams.get("libraryId"), "/fixture/lib0");
      return new Response(JSON.stringify({
        codeSnippets: Array.from({ length: 12 }, (_, i) => ({
          codeList: [{ language: "js", code: `example${i}();` }],
        })),
        infoSnippets: Array.from({ length: 12 }, (_, i) => ({ content: `Documentation ${i}` })),
      }));
    });
    await h.session.prompt("Run the fixture tools.");
    assert.equal(requests.length, 2);
    assert.equal(contextRequests.length, 3, "docs must still resolve the library name automatically");
    for (const name of ["library_search", "library_docs"]) {
      const tool = declaredTools(requests[0]).find(tool => tool.name === name);
      assert.ok(tool);
      assert.equal(tool.strict, supportsStrictMode ? true : undefined);
      const schema = tool.parameters;
      const limit = supportsStrictMode ? schema.properties.limit.anyOf[0] : schema.properties.limit;
      assert.equal(limit.minimum, 1);
      assert.equal(limit.maximum, 20);
      if (supportsStrictMode) {
        assert.deepEqual(schema.required, Object.keys(schema.properties));
        assert.deepEqual(schema.properties.limit.anyOf[1], { type: "null" });
      } else {
        assert.equal(schema.required.includes("limit"), false);
      }
      const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === name);
      assert.ok(result);
      assert.equal(result.isError, false);
      const data = JSON.parse(result.content[0].text);
      if (name === "library_search") assert.equal(data.results.length, 10);
      else {
        assert.equal(data.codeSnippets.length, 10);
        assert.equal(data.infoSnippets.length, 10);
      }
    }
    assert.deepEqual(h.errors, []);
  });

  test(`real Pi rejects out-of-range Context7 calls locally with strict support ${supportsStrictMode}`, async t => {
    const h = await harness(t, supportsStrictMode);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
      assert.equal(new URL(String(url)).hostname, "api.openai.com", "invalid calls must not reach Context7");
      requests++;
      assert.ok(requests <= 2, "unexpected model continuation");
      return response(requests === 1 ? [
        toolCall("library_search", { libraryName: "fixture", limit: 6000 }),
        toolCall("library_docs", { libraryName: "fixture", query: "docs question", limit: 6000 }),
      ] : [answer]);
    });
    await h.session.prompt("Run invalid fixture calls.");
    assert.equal(requests, 2);
    const results = h.session.messages.filter(message => message.role === "toolResult");
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /limit.*20/);
    }
    assert.deepEqual(h.errors, []);
  });
}
