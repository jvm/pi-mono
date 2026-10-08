import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { codexHarness, requestBody, testToken, textResponse } from "../../../tests/codex-harness.mjs";

process.env.CI = "1";
const agentDir = await mkdtemp(join(tmpdir(), "pi-fast-extension-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: piFast } = await import("../extensions/index.ts");
const { FAST_SERVICE_TIER, PRIORITY_SERVICE_TIER, applyFastMode, supportsFastMode } = await import("../src/fast-mode.ts");

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  return {
    events: new EventEmitter(),
    handlers,
    commands,
    shortcuts,
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut(key, shortcut) {
      shortcuts.set(key, shortcut);
    },
  };
}

function makeContext(model, hasUI = true, mode = hasUI ? "tui" : "print", isUsingOAuth = false) {
  const statuses = [];
  const notifications = [];
  return {
    model,
    mode,
    hasUI,
    modelRegistry: { isUsingOAuth: () => isUsingOAuth },
    statuses,
    notifications,
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: (key, value) => statuses.push({ key, value }),
      notify: (message, type) => notifications.push({ message, type }),
    },
  };
}

test("recognizes only allowlisted models on supported OpenAI provider/API pairs", () => {
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-6.1-sol" }), true);
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-6-astra" }), true);
  assert.equal(supportsFastMode({ provider: "openai", id: "gpt-6-astra" }), false);
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-6-astra-pro" }), false);
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-5.4" }), true);
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-5.6-sol" }), true);
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-5.4-mini" }), false);
  assert.equal(supportsFastMode({ provider: "openai", id: "gpt-5.4" }), false);
  assert.equal(supportsFastMode({ provider: "openai", api: "openai-responses", id: "gpt-5.4" }), true);
  assert.equal(supportsFastMode({ provider: "openai", api: "openai-completions", id: "gpt-5.4" }), false);
  for (const id of [
    "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.4", "gpt-5.5",
    "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
  ]) {
    assert.equal(supportsFastMode({ provider: "openai", api: "openai-responses", id }), true);
    assert.equal(supportsFastMode({ provider: "openai-codex", id }), true);
  }
  assert.equal(supportsFastMode(undefined), false);
  assert.equal(supportsFastMode({ provider: "openai", api: "openai-responses", id: "gpt-6-unknown" }), false);
});

test("adds Codex priority processing without mutating the original payload", () => {
  const payload = { model: "gpt-5.4", input: [] };
  const updated = applyFastMode(payload, { provider: "openai-codex", id: "gpt-5.4" });

  assert.deepEqual(updated, { ...payload, service_tier: PRIORITY_SERVICE_TIER });
  assert.deepEqual(payload, { model: "gpt-5.4", input: [] });
  assert.deepEqual(
    applyFastMode(payload, { provider: "openai-codex", id: "gpt-5.4-mini" }),
    payload,
  );
});

test("defaults OpenAI API access to fast and uses priority only for subscription compatibility", () => {
  const payload = { input: [], service_tier: "default" };
  const model = { provider: "openai", api: "openai-responses", id: "gpt-6.1-sol" };
  assert.equal(FAST_SERVICE_TIER, "fast");
  assert.equal(PRIORITY_SERVICE_TIER, "priority");
  assert.deepEqual(applyFastMode(payload, model), { ...payload, service_tier: "fast" });
  assert.deepEqual(applyFastMode(payload, model, false), { ...payload, service_tier: "fast" });
  assert.deepEqual(applyFastMode(payload, model, true), { ...payload, service_tier: "priority" });
  assert.deepEqual(applyFastMode(payload, { provider: "openai-codex", id: model.id }), {
    ...payload, service_tier: "priority",
  });
  assert.equal(payload.service_tier, "default");
});

test("keeps Fast off by default and rewrites supported provider requests after toggling", async () => {
  const pi = makePi();
  piFast(pi);
  const context = makeContext({ provider: "openai-codex", id: "gpt-5.4" });
  const beforeRequest = pi.handlers.get("before_provider_request")[0];

  assert.deepEqual(await beforeRequest({ payload: { model: "gpt-5.4" } }, context), undefined);
  await pi.handlers.get("session_start")[0]({}, context);
  assert.deepEqual(context.statuses.at(-1), { key: "pi-fast", value: "Fast off" });

  await pi.commands.get("fast").handler("on", context);
  assert.deepEqual(context.statuses.at(-1), { key: "pi-fast", value: "Fast on" });
  assert.deepEqual(
    await beforeRequest({ payload: { model: "gpt-5.4" } }, context),
    { model: "gpt-5.4", service_tier: "priority" },
  );

  await pi.shortcuts.get("ctrl+shift+r").handler(context);
  assert.deepEqual(context.statuses.at(-1), { key: "pi-fast", value: "Fast off" });

  await pi.commands.get("fast").handler("on", context);
  await pi.handlers.get("session_start")[0]({}, context);
  assert.deepEqual(context.statuses.at(-1), { key: "pi-fast", value: "Fast off" });
  assert.deepEqual(await beforeRequest({ payload: { model: "gpt-5.4" } }, context), undefined);
});

test("enables Fast by default for supported models when configured", async () => {
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(
    settingsPath,
    `${JSON.stringify({ "pi-fast": { enabledByDefault: true } }, null, 2)}\n`,
    "utf-8",
  );

  try {
    const pi = makePi();
    piFast(pi);
    const context = makeContext({ provider: "openai-codex", id: "gpt-5.4-mini" });
    const beforeRequest = pi.handlers.get("before_provider_request")[0];

    await pi.handlers.get("session_start")[0]({}, context);
    assert.deepEqual(context.statuses.at(-1), { key: "pi-fast", value: "Fast n/a" });

    context.model = { provider: "openai-codex", id: "gpt-5.4" };
    await pi.handlers.get("model_select")[0]({}, context);
    assert.deepEqual(context.statuses.at(-1), { key: "pi-fast", value: "Fast on" });
    assert.deepEqual(
      await beforeRequest({ payload: { model: "gpt-5.4" } }, context),
      { model: "gpt-5.4", service_tier: "priority" },
    );
  } finally {
    await rm(settingsPath, { force: true });
  }
});

test("keeps Fast off when global settings contain malformed JSON", async () => {
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, "{ malformed", "utf-8");

  try {
    const pi = makePi();
    piFast(pi);
    const context = makeContext({ provider: "openai-codex", id: "gpt-5.4" });

    await pi.handlers.get("session_start")[0]({}, context);

    assert.deepEqual(context.statuses.at(-1), { key: "pi-fast", value: "Fast off" });
    assert.equal(
      await pi.handlers.get("before_provider_request")[0]({ payload: {} }, context),
      undefined,
    );
  } finally {
    await rm(settingsPath, { force: true });
  }
});

test("does not render footer status outside TUI", async () => {
  const pi = makePi();
  piFast(pi);
  const context = makeContext({ provider: "openai-codex", id: "gpt-5.4" }, true, "print");

  await pi.handlers.get("session_start")[0]({}, context);

  assert.deepEqual(context.statuses, []);
});

test("does not enable Fast for unsupported models", async () => {
  const pi = makePi();
  piFast(pi);
  const context = makeContext({ provider: "openai-codex", id: "gpt-5.4-mini" });

  await pi.handlers.get("session_start")[0]({}, context);
  await pi.commands.get("fast").handler("on", context);

  assert.deepEqual(context.statuses.at(-1), { key: "pi-fast", value: "Fast n/a" });
  assert.equal(context.notifications.at(-1).type, "warning");
  assert.equal(await pi.handlers.get("before_provider_request")[0]({ payload: {} }, context), undefined);
});

for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
  test(`${id} sends the Fast tier through the real Pi provider pipeline`, async (t) => {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requests.push(requestBody(init));
      return textResponse();
    });
    const h = await codexHarness([piFast]);
    try {
      await h.session.setModel({ ...h.model, id });
      await h.session.prompt("/fast on");
      await h.session.prompt("Reply OK", { expandPromptTemplates: false });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, id);
      assert.equal(requests[0].service_tier, "priority");
      assert.equal(h.session.messages.at(-1).stopReason, "stop");

      await h.session.prompt("/fast off");
      await h.session.prompt("Reply OK again", { expandPromptTemplates: false });
      assert.equal(requests.length, 2);
      assert.equal(requests[1].service_tier, undefined);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  });

  test(`${id} toggles preserve request fields and survive model switches without widening support`, async () => {
    const pi = makePi();
    piFast(pi);
    const context = makeContext({ provider: "openai-codex", id });
    const request = pi.handlers.get("before_provider_request")[0];
    const payload = { input: [], reasoning: { effort: "max" }, service_tier: "default" };
    await pi.handlers.get("session_start")[0]({}, context);
    assert.equal(context.statuses.at(-1).value, "Fast off");
    assert.equal(await request({ payload }, context), undefined);
    await pi.commands.get("fast").handler("on", context);
    assert.equal(context.statuses.at(-1).value, "Fast on");
    assert.deepEqual(await request({ payload }, context), { ...payload, service_tier: "priority" });
    assert.equal(payload.service_tier, "default");
    for (const model of [
      { provider: "openai", id },
      { provider: "anthropic", id },
      { provider: "openai-codex", id: `${id}-pro` },
      { provider: "openai-codex", id: "gpt-6-unknown" },
    ]) {
      context.model = model;
      await pi.handlers.get("model_select")[0]({}, context);
      assert.equal(context.statuses.at(-1).value, "Fast n/a");
      assert.equal(await request({ payload }, context), undefined);
    }
    context.model = { provider: "openai-codex", id };
    await pi.handlers.get("model_select")[0]({}, context);
    assert.equal(context.statuses.at(-1).value, "Fast on");
    await pi.commands.get("fast").handler("off", context);
    assert.equal(context.statuses.at(-1).value, "Fast off");
    assert.equal(await request({ payload }, context), undefined);
    for (const malformed of [undefined, null, [], "payload"]) {
      assert.equal(applyFastMode(malformed, context.model), malformed);
    }
  });
}

for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.4"]) {
  test(`${id} sends Fast through OpenAI Responses with OAuth and API-key auth`, async (t) => {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requests.push(requestBody(init));
      return textResponse();
    });
    let h;
    try {
      const credentials = new InMemoryCredentialStore();
      const credential = {
        type: "oauth", access: testToken, refresh: "unused-fixture", expires: Date.now() + 3_600_000,
      };
      await credentials.modify("openai", async () => credential);
      const modelRuntime = await ModelRuntime.create({
        credentials, modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"),
      });
      // The pinned Pi predates /login openai. Supply OAuth through its public provider API
      // to test the real auth snapshot, extension runner and Responses serializer.
      const provider = modelRuntime.getProvider("openai");
      modelRuntime.registerNativeProvider({
        ...provider,
        auth: {
          ...provider.auth,
          oauth: {
            name: "ChatGPT fixture",
            isSubscription: true,
            login: async () => credential,
            refresh: async () => credential,
            toAuth: async () => ({ apiKey: testToken }),
          },
        },
      });
      await modelRuntime.refresh({ allowNetwork: false });
      h = await codexHarness([piFast], { modelRuntime });
      await h.session.setModel({ ...modelRuntime.getModel("openai", "gpt-6-astra"), id });
      assert.equal(h.ctx.modelRegistry.isUsingOAuth(h.ctx.model), true);
      await h.session.prompt("Reply OK", { expandPromptTemplates: false });
      assert.equal(requests[0].service_tier, undefined);
      await h.session.prompt("/fast on");
      await h.session.prompt("Reply OK again", { expandPromptTemplates: false });
      assert.equal(requests[1].model, id);
      assert.equal(requests[1].service_tier, "priority");
      assert.equal(h.session.messages.at(-1).stopReason, "stop");
      await h.session.prompt("/fast off");
      await h.session.prompt("Reply OK once more", { expandPromptTemplates: false });
      assert.equal(requests[2].service_tier, undefined);

      await h.session.prompt("/fast on");
      await modelRuntime.setRuntimeApiKey("openai", "unused-api-key-fixture");
      assert.equal(h.ctx.modelRegistry.isUsingOAuth(h.ctx.model), false);
      await h.session.prompt("API-key request", { expandPromptTemplates: false });
      assert.equal(requests[3].service_tier, "fast");
      assert.equal(h.session.messages.at(-1).stopReason, "stop");
      await h.session.prompt("/fast off");
      await h.session.prompt("Standard API-key request", { expandPromptTemplates: false });
      assert.equal(requests[4].service_tier, undefined);

      // Resolve auth on each request, not when toggling or selecting a model.
      await h.session.prompt("/fast on");
      await modelRuntime.removeRuntimeApiKey("openai");
      assert.equal(h.ctx.modelRegistry.isUsingOAuth(h.ctx.model), true);
      await h.session.prompt("Subscription request again", { expandPromptTemplates: false });
      assert.equal(requests[5].service_tier, "priority");
      assert.equal(h.session.messages.at(-1).stopReason, "stop");
      assert.deepEqual(h.errors, []);
    } finally {
      try {
        await h?.close();
      } finally {
        t.mock.restoreAll();
      }
    }
  });

  for (const isUsingOAuth of [true, false]) {
    test(`${id} supports OpenAI ${isUsingOAuth ? "ChatGPT OAuth" : "API-key"} requests`, async () => {
      const pi = makePi();
      piFast(pi);
      const model = { provider: "openai", api: "openai-responses", id };
      const context = makeContext(model, true, "tui", isUsingOAuth);
      const tier = isUsingOAuth ? "priority" : "fast";
      const request = pi.handlers.get("before_provider_request")[0];
      const payload = { model: id, input: [], service_tier: "default" };
      assert.equal(supportsFastMode(model), true);
      await pi.handlers.get("session_start")[0]({}, context);
      assert.equal(context.statuses.at(-1).value, "Fast off");
      assert.equal(await request({ payload }, context), undefined);
      await pi.commands.get("fast").handler("on", context);
      assert.equal(context.statuses.at(-1).value, "Fast on");
      assert.deepEqual(await request({ payload }, context), { ...payload, service_tier: tier });
      assert.equal(payload.service_tier, "default");

      context.modelRegistry.isUsingOAuth = () => !isUsingOAuth;
      const switchedTier = isUsingOAuth ? "fast" : "priority";
      assert.deepEqual(await request({ payload }, context), { ...payload, service_tier: switchedTier });
      context.modelRegistry.isUsingOAuth = () => isUsingOAuth;

      for (const ctx of [
        makeContext({ ...model, api: "openai-completions" }, true, "tui", true),
        makeContext({ ...model, id: `${id}-pro` }, true, "tui", true),
        makeContext({ ...model, provider: "anthropic" }, true, "tui", true),
      ]) {
        await pi.handlers.get("model_select")[0]({}, ctx);
        assert.equal(ctx.statuses.at(-1).value, "Fast n/a");
        assert.equal(await request({ payload }, ctx), undefined);
        await pi.commands.get("fast").handler("on", ctx);
        assert.equal(ctx.notifications.at(-1).type, "warning");
      }

      await pi.handlers.get("model_select")[0]({}, context);
      assert.equal(context.statuses.at(-1).value, "Fast on");
      await pi.commands.get("fast").handler("off", context);
      assert.equal(context.statuses.at(-1).value, "Fast off");
      assert.equal(await request({ payload }, context), undefined);
    });
  }
}

test.after(async () => {
  await rm(agentDir, { recursive: true, force: true });
});
