import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import subsUsage from "../index.ts";
import { assertBackgroundAuthSafe } from "../src/background-auth.ts";
import { resolveUsageRequest } from "../src/auth.ts";
import { STATUS_KEY } from "../src/monitor.ts";
import { backgroundAuthMetadata, cases, legacyToken, model } from "./fixtures.mjs";

const blocked = "[command auth unsupported]";
const go = cases[4];
const goConfig = models => ({ baseUrl: go.baseUrl, api: "openai-completions", models });

async function setup(t, configure) {
  const dir = await mkdtemp(join(tmpdir(), "pi-subs-command-auth-"));
  const oldEnv = { ...process.env };
  process.env.PI_TELEMETRY = "0";
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_OFFLINE;
  t.after(async () => {
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  });
  const counter = join(dir, "command-count");
  const script = join(dir, "slow-key.cjs");
  await writeFile(counter, "");
  await writeFile(script, `
    require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x");
    setTimeout(() => process.stdout.write("unused-command-fixture"), 250);
  `);
  // Both paths are controlled test fixtures. The extension must never run this.
  const command = `!${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  const config = configure(command);
  const modelsPath = join(dir, "models.json");
  const authPath = join(dir, "auth.json");
  await writeFile(modelsPath, JSON.stringify({ providers: config.providers }), { mode: 0o600 });
  await writeFile(authPath, JSON.stringify(config.stored ?? {}), { mode: 0o600 });
  const runtime = await ModelRuntime.create({
    modelsPath, authPath, modelsStorePath: join(dir, "models-store.json"),
    // Pi's own startup availability checks are outside this extension. In the
    // stored-command test they would execute the command before monitoring.
    refreshOnCreate: !config.stored, allowModelNetwork: false,
    ...(config.stored ? {} : { credentials: new InMemoryCredentialStore() }),
  });
  const registry = new ModelRegistry(runtime);
  const models = Object.entries(config.providers).flatMap(([provider, entry]) =>
    (entry.models ?? []).map(({ id }) => {
      const selected = runtime.getModel(provider, id);
      assert.ok(selected, `${provider}/${id} must exist in the real Pi catalog`);
      return selected;
    }));
  t.mock.method(registry, "getAvailable", () => models);
  const auth = t.mock.method(registry, "getApiKeyAndHeaders");
  const providerAuth = t.mock.method(registry, "getProviderAuth");
  const handlers = new Map();
  const commands = new Map();
  const statuses = new Map();
  const ctx = {
    mode: "tui", isProjectTrusted: () => false,
    model: { ...model(go), provider: "unsupported-active-provider" },
    modelRegistry: registry, ui: { setStatus: (key, value) => statuses.set(key, value) },
  };
  subsUsage({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
  });
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  t.after(() => emit("session_shutdown"));
  const refresh = () => commands.get("subs-usage").handler("refresh", ctx);
  return {
    command, runtime, registry, models, auth, providerAuth, emit, refresh, authPath, modelsPath,
    commandCount: async () => (await readFile(counter, "utf8")).length,
    status: selected => {
      ctx.model = selected;
      emit("model_select", { model: selected });
      return statuses.get(STATUS_KEY);
    },
  };
}

test("real Pi entrypoint skips seven inactive slow key commands on startup and repeated polls", async t => {
  const h = await setup(t, command => ({ providers: {
    "opencode-go": { ...goConfig(Array.from({ length: 7 }, (_, i) => ({ id: `slow-${i}` }))), apiKey: command },
    zai: { baseUrl: cases[3].baseUrl, api: "openai-completions", apiKey: cases[3].token, models: [{ id: "safe" }] },
  } }));
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.z.ai/api/monitor/usage/quota/limit");
    assert.equal(init.headers.Authorization, `Bearer ${cases[3].token}`);
    await delay(30); // Leave the event loop observable while a safe request runs.
    return Response.json(cases[3].payload);
  });
  let maxGap = 0;
  let last = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  t.after(() => clearInterval(heartbeat));
  for (let cycle = 0; cycle < 2; cycle++) {
    if (cycle === 0) h.emit("session_start");
    await h.refresh();
    await delay(20);
    assert.equal(await h.commandCount(), 0);
    assert.equal(h.auth.mock.callCount(), cycle + 1, "only the safe model may resolve auth");
    assert.equal(fetch.mock.callCount(), cycle + 1);
    for (const selected of h.models.filter(m => m.provider === "opencode-go")) {
      assert.equal(h.status(selected), blocked);
    }
    assert.match(h.status(h.models.at(-1)), /^\[5h/);
  }
  // The zero-execution assertion is deterministic; this also catches the
  // original ~2-second event-loop stall with seven 250 ms command fixtures.
  assert.ok(maxGap < 1000, `background polling blocked the heartbeat for ${Math.round(maxGap)} ms`);
});

test("real hidden model commands are skipped without losing safe per-model authorization overrides", async t => {
  const h = await setup(t, command => ({ providers: {
    "opencode-go": {
      ...goConfig([
        { id: "safe-a" },
        { id: "safe-b", headers: { Authorization: "Bearer unused-other-account" } },
        { id: "command-model", headers: { Authorization: command } },
        { id: "command-override" },
      ]),
      apiKey: go.token,
      modelOverrides: { "command-override": { headers: { "X-Trace": command } } },
    },
  } }));
  assert.ok(h.models.every(m => m.headers === undefined), "Pi hides these headers from the public catalog");
  t.mock.method(globalThis, "fetch", async (_url, init) => Response.json({
    usage: { rolling: { percent: init.headers.Authorization === `Bearer ${go.token}` ? 11 : 72 } },
  }));
  h.emit("session_start");
  await h.refresh();
  assert.match(h.status(h.models[0]), /11%/);
  assert.match(h.status(h.models[1]), /72%/);
  assert.equal(h.status(h.models[2]), blocked);
  assert.equal(h.status(h.models[3]), blocked);
  assert.equal(h.auth.mock.callCount(), 2);
  assert.equal(await h.commandCount(), 0);
});

test("real provider headers and extension-registered key/header commands are checked before auth", async t => {
  const h = await setup(t, command => ({ providers: {
    "opencode-go": { ...goConfig([{ id: "fixture" }]), apiKey: go.token, headers: { "X-Trace": command } },
  } }));
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("No quota request is allowed"));
  h.emit("session_start");
  await h.refresh();
  assert.equal(h.status(h.models[0]), blocked);

  for (const config of [
    { apiKey: h.command },
    { headers: { "X-Trace": h.command } },
    { models: [{ ...h.models[0], headers: { Authorization: h.command } }] },
  ]) {
    // A safe extension override masks the original provider header, so each
    // iteration independently exercises the extension's command-bearing field.
    h.registry.registerProvider("opencode-go", { headers: { "X-Trace": "safe" }, ...config });
    await h.refresh();
    assert.equal(h.status(h.models[0]), blocked);
  }
  assert.equal(h.auth.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await h.commandCount(), 0);
});

test("real auth.json commands are skipped without resolving or caching them; edits recover on the next poll", async t => {
  const h = await setup(t, command => ({
    providers: { "opencode-go": { ...goConfig([{ id: "fixture" }]) } },
    stored: { "opencode-go": { type: "api_key", key: command } },
  }));
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${go.token}`);
    return Response.json(go.payload);
  });
  // Pi treats an empty runtime key as absent, despite the map having an entry.
  // It must not hide the command in the backing AuthStorage during preflight.
  h.registry.runtime.credentials.overrides.set("opencode-go", "");
  h.emit("session_start");
  await h.refresh();
  await h.refresh();
  assert.equal(h.status(h.models[0]), blocked);
  assert.equal(h.auth.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await h.commandCount(), 0);

  await writeFile(h.authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: go.token } }), { mode: 0o600 });
  await h.refresh();
  assert.match(h.status(h.models[0]), /^\[5h/);
  assert.equal(fetch.mock.callCount(), 1);

  await writeFile(h.authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: h.command } }), { mode: 0o600 });
  await h.refresh();
  assert.equal(h.status(h.models[0]), blocked, "a newly configured command clears the former numeric reading");
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(await h.commandCount(), 0);
});

test("the native OpenAI fallback cannot execute Codex provider commands", async t => {
  const h = await setup(t, command => ({ providers: {
    openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", apiKey: "unused-native-key", models: [{ id: "fixture" }] },
    "openai-codex": { headers: { "X-Trace": command } },
  } }));
  t.mock.method(globalThis, "fetch", () => assert.fail("No quota request is allowed"));
  h.emit("session_start");
  await h.refresh();
  assert.equal(h.status(h.models[0]), blocked);
  assert.equal(h.providerAuth.mock.callCount(), 0);
  assert.equal(h.auth.mock.callCount(), 0);
  assert.equal(await h.commandCount(), 0);
});

test("unknown Pi metadata fails closed; cancelling a raw credential read prevents later resolution", async () => {
  const fixture = model(go);
  for (const metadata of [{}, { runtime: {} }, {
    ...backgroundAuthMetadata(),
    runtime: { ...backgroundAuthMetadata().runtime, credentials: {
      overrides: new Map(), store: { readState: { data: {} }, read: () => assert.fail("Do not fall through") },
    } },
  }]) {
    await assert.rejects(assertBackgroundAuthSafe(metadata, fixture), /background auth unavailable/);
  }
  let finish;
  const registry = {
    ...backgroundAuthMetadata(),
    getApiKeyAndHeaders: () => assert.fail("Cancelled checks must never resolve auth"),
  };
  registry.runtime.credentials.store.read = () => new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const pending = resolveUsageRequest(go.provider, fixture, registry, undefined, controller.signal);
  controller.abort();
  finish({ type: "api_key", key: go.token });
  await assert.rejects(pending, { name: "AbortError" });
});

test("configuration changes during the raw credential check are inspected before resolving auth", async () => {
  let finish;
  const registry = {
    ...backgroundAuthMetadata(),
    getApiKeyAndHeaders: () => assert.fail("Do not resolve newly configured commands"),
  };
  registry.runtime.credentials.store.read = () => new Promise(resolve => { finish = resolve; });
  const pending = resolveUsageRequest(go.provider, model(go), registry);
  registry.runtime.config = { getProvider: () => ({ headers: { Authorization: "!never-run" } }) };
  finish({ type: "api_key", key: go.token });
  await assert.rejects(pending, /command auth unsupported/);
});

test("safe environment and literal headers retain Pi precedence; commands in other models do not disable the provider", async t => {
  const h = await setup(t, command => ({ providers: {
    "opencode-go": {
      ...goConfig([{ id: "safe", headers: { Authorization: "Bearer ${SUBS_USAGE_TEST_TOKEN}" } },
        { id: "unused-command", headers: { Authorization: command } }]),
      apiKey: go.token,
      modelOverrides: { safe: { headers: { Authorization: command } } },
    },
  } }));
  process.env.SUBS_USAGE_TEST_TOKEN = "unused-environment-fixture";
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.Authorization, "Bearer unused-environment-fixture");
    return Response.json(go.payload);
  });
  h.emit("session_start");
  await h.refresh();
  assert.match(h.status(h.models[0]), /^\[5h/);
  assert.equal(h.status(h.models[1]), blocked);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(await h.commandCount(), 0);
});

test("safe Codex fallback ignores unused native command auth and still uses Pi OAuth", async () => {
  const registry = {
    ...backgroundAuthMetadata(),
    getProvider: () => ({ baseUrl: cases[0].baseUrl }),
    getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: legacyToken } }),
    getApiKeyAndHeaders: () => assert.fail("Native auth is not the quota source"),
  };
  registry.runtime.config.getProvider = provider => provider === "openai" ? { apiKey: "!never-run" } : undefined;
  const request = await resolveUsageRequest("openai", { ...model(cases[0]), provider: "openai", baseUrl: "https://api.openai.com/v1" }, registry);
  assert.equal(request.headers.Authorization, `Bearer ${legacyToken}`);
});
