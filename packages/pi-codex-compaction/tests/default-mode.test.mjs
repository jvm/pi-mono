import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/index.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";

function fixture(modelChanges = {}, flagOverride, thresholdOverride) {
  const handlers = new Map();
  const flags = new Map();
  const commands = new Map();
  const entries = [];
  const notices = [];
  let authCalls = 0;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerFlag: (name, definition) => flags.set(name, definition),
    getFlag: (name) => name === "server-compaction-threshold" && thresholdOverride !== undefined ? thresholdOverride
      : name === "server-compaction" && flagOverride !== undefined ? flagOverride : flags.get(name)?.default,
    registerCommand: (name, definition) => commands.set(name, definition),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    getSettings: () => ({ compaction: { enabled: true, reserveTokens: 8192 } }),
  };
  const ctx = {
    model: { provider: "openai", api: "openai-responses", id: "gpt-6-astra",
      baseUrl: "https://api.openai.com/v1", contextWindow: 100_000, ...modelChanges },
    modelRegistry: {
      async getApiKeyAndHeaders() { authCalls++; return { ok: true, apiKey: "synthetic-test-credential" }; },
      isUsingOAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => "fixture",
      getLeafId: () => "user",
      getBranch: () => entries,
      buildSessionProjection: () => ({ entries: [], messages: [] }),
    },
    hasUI: true,
    ui: { notify: (message) => notices.push(message) },
    waitForIdle: async () => {},
  };
  extension(pi);
  const dispatch = (name, event = {}) => handlers.get(name)?.(event, ctx);
  dispatch("session_start");
  dispatch("turn_start");
  return {
    flags, commands, handlers, ctx, notices, authCalls: () => authCalls,
    payload: () => ({ model: ctx.model.id, input: [] }),
    request: (payload) => dispatch("before_provider_request", { payload }),
    warm: () => dispatch("cache_warming_decision", { action: "warm" }),
    toggle: (args) => commands.get("server-compaction").handler(args, ctx),
    context: (names) => dispatch("context_with_system", { messages: [
      { role: "system", content: "Synthetic", timestamp: 0, toolsAdded: names.map(name => ({
        name, description: "Synthetic tool", parameters: { type: "object", properties: {} },
      })) },
    ] }),
  };
}

test("default-on registration uses only the public request pipeline", async () => {
  const h = fixture();
  assert.equal(h.flags.get("server-compaction").default, true);
  assert.deepEqual([...h.flags.keys()].sort(), ["server-compaction", "server-compaction-threshold"]);
  assert.equal(h.handlers.has("before_provider_headers"), false, "no legacy beta header hook");
  const payload = h.payload();
  const result = await h.request(payload);
  assert.deepEqual(result.context_management, [{ type: "compaction", compact_threshold: 55084 }]);
  assert.equal(payload.context_management, undefined);
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
});

  test("automatic adaptation promotes the initial base and preserves later updates without a strategy flag", async () => {
    const h = fixture();
    await h.context(["base", "late", "hidden"]);
    const tool = name => ({ type: "function", name, parameters: { type: "object", properties: {} } });
    const payload = { ...h.payload(), prompt_cache_key: "synthetic-affinity", input: [
      { type: "additional_tools", role: "developer", tools: [tool("base")] },
      { role: "developer", content: "An anchored prompt update" },
      { type: "additional_tools", role: "developer", tools: [tool("late")] },
    ] };
    const before = JSON.stringify(payload);
    const result = await h.request(payload);
    assert.ok(result.context_management);
    assert.deepEqual(result.input, payload.input.slice(1));
    assert.equal(JSON.stringify(payload), before);
    assert.equal(result.prompt_cache_key, payload.prompt_cache_key);
    assert.deepEqual(result.tools[0].tools.map(t => t.name), ["base"]);
    assert.deepEqual(h.warm(), { action: "stop" });
  });
  for (const variant of ["off", "invalid-threshold", "foreign-policy", "foreign-tools"]) {
    test(`automatic inline adaptation leaves ${variant} requests untouched without auth resolution`, async () => {
      const h = fixture({}, variant === "off" ? false : undefined, variant === "invalid-threshold" ? "0" : undefined);
      await h.context(["base"]);
      const payload = { ...h.payload(), input: [{ type: "additional_tools", role: "developer", tools: [
        { type: "function", name: "base", parameters: { type: "object", properties: {} } },
      ] }], ...(variant === "foreign-policy" ? { context_management: [{ type: "compaction", compact_threshold: 9999 }] } : {}),
        ...(variant === "foreign-tools" ? { tools: [{ type: "web_search" }] } : {}) };
      const before = JSON.stringify(payload);
      assert.equal(await h.request(payload), undefined);
      assert.equal(JSON.stringify(payload), before);
      assert.equal(h.authCalls(), 0);
      assert.equal(h.warm(), undefined);
    });
  }

for (const modelChanges of [
  { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
  { provider: "anthropic", api: "anthropic-messages" },
  { baseUrl: "https://example.com/v1" },
  { api: "openai-completions" },
  { id: "unverified-model" },
]) {
  test(`default-on leaves unrelated route and warming untouched: ${JSON.stringify(modelChanges)}`, async () => {
    const h = fixture(modelChanges);
    assert.equal(await h.request(h.payload()), undefined);
    assert.equal(h.authCalls(), 0);
    assert.equal(h.warm(), undefined);
    await h.toggle("status");
    assert.match(h.notices.at(-1), /unavailable for the current provider\/model/);
  });
}

test("warming follows the actual request, not the default toggle", async () => {
  const h = fixture();
  assert.equal(h.warm(), undefined, "no automatic request was sent");
  await h.request({ ...h.payload(), input: [{ type: "configuration_update", reasoning: { effort: "high" }, unsupported: true }] });
  assert.equal(h.warm(), undefined, "incompatible requests keep their existing warming policy");
  await h.request(h.payload());
  assert.deepEqual(h.warm(), { action: "stop" });
  await h.toggle("off");
  assert.deepEqual(h.warm(), { action: "stop" }, "cached automatic request is still unsafe to warm");
  await h.request(h.payload());
  assert.equal(h.warm(), undefined, "new ordinary request replaces the cached automatic request");
});

test("an explicit false startup flag disables automatic requests and warming interception", async () => {
  const h = fixture({}, false);
  assert.equal(await h.request(h.payload()), undefined);
  assert.equal(h.warm(), undefined);
  assert.equal(h.authCalls(), 0);
});

test("unmapped inline tools skip auth resolution and preserve ordinary cache warming", async () => {
  const h = fixture();
  const payload = { ...h.payload(), input: [{ type: "additional_tools", role: "developer", tools: [] }] };
  assert.equal(await h.request(payload), undefined);
  assert.equal(h.authCalls(), 0);
  assert.equal(h.warm(), undefined);
  await h.request(h.payload());
  assert.deepEqual(h.warm(), { action: "stop" });
  assert.equal(await h.request(payload), undefined);
  assert.equal(h.warm(), undefined, "a new inline-tools request replaces the cached automatic request");
});

for (const position of [0, 1, 2]) {
  test(`inline declaration at input position ${position} preserves history, grammar, Fast and reasoning`, async () => {
    const h = fixture();
    await h.context(["ping"]);
    const input = [{ role: "developer", content: "Synthetic system state" },
      { role: "user", content: "Synthetic user input" }];
    input.splice(position, 0, { type: "additional_tools", role: "developer", tools: [{
      type: "namespace", name: "fixtures", description: "Synthetic tools", tools: [{
        type: "custom", name: "ping", format: { type: "grammar", syntax: "lark", definition: 'start: "PING"' },
      }],
    }] });
    const payload = { ...h.payload(), input, store: true, stream: true, service_tier: "priority",
      reasoning: { effort: "high" } };
    const expected = structuredClone(payload);
    const result = await h.request(payload);
    if (position === 2) {
      assert.ok(result.context_management);
      assert.equal(result.input, payload.input, "Do not remove declarations introduced after user input");
      assert.deepEqual(payload, expected);
      assert.equal(h.authCalls(), 1);
      return;
    }
    assert.ok(result.context_management);
    assert.deepEqual(result.input, input.filter((_, i) => i !== position));
    assert.equal(result.service_tier, "priority");
    assert.deepEqual(result.reasoning, payload.reasoning);
    assert.deepEqual(result.tools, input[position].tools);
    assert.deepEqual(payload, expected);
    assert.equal(h.authCalls(), 1);
    assert.deepEqual(h.warm(), { action: "stop" });
  });
}

test("model switches do not carry an automatic warming veto to another provider", async () => {
  const h = fixture();
  await h.request(h.payload());
  h.ctx.model = { ...h.ctx.model, provider: "anthropic", api: "anthropic-messages" };
  assert.equal(h.warm(), undefined);
  assert.equal(await h.request(h.payload()), undefined);
});

test("package exports no legacy transport or compat serializer helpers", async () => {
  const exports = await import("../src/index.ts");
  assert.deepEqual(Object.keys(exports).sort(), ["PACKAGE_NAME", "registerAutomaticCompaction"]);
});
