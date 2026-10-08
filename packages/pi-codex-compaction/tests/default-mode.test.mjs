import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/index.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";

function fixture(modelChanges = {}, flagOverride) {
  const handlers = new Map();
  const flags = new Map();
  const commands = new Map();
  const entries = [];
  const notices = [];
  let authCalls = 0;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerFlag: (name, definition) => flags.set(name, definition),
    getFlag: (name) => name === "server-compaction" && flagOverride !== undefined
      ? flagOverride : flags.get(name)?.default,
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
  };
}

test("default-on registration uses only the public request pipeline", async () => {
  const h = fixture();
  assert.equal(h.flags.get("server-compaction").default, true);
  assert.equal(h.handlers.has("before_provider_headers"), false, "no legacy beta header hook");
  const payload = h.payload();
  const result = await h.request(payload);
  assert.deepEqual(result.context_management, [{ type: "compaction", compact_threshold: 55084 }]);
  assert.equal(payload.context_management, undefined);
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
});

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
  await h.request({ ...h.payload(), input: [{ type: "configuration_update", reasoning: { effort: "high" } }] });
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
