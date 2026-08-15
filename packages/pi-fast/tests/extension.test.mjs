import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.CI = "1";
const agentDir = await mkdtemp(join(tmpdir(), "pi-fast-extension-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: piFast } = await import("../extensions/index.ts");
const { FAST_SERVICE_TIER, applyFastMode, supportsFastMode } = await import("../src/fast-mode.ts");

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  return {
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

function makeContext(model, hasUI = true, mode = hasUI ? "tui" : "print") {
  const statuses = [];
  const notifications = [];
  return {
    model,
    mode,
    hasUI,
    statuses,
    notifications,
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: (key, value) => statuses.push({ key, value }),
      notify: (message, type) => notifications.push({ message, type }),
    },
  };
}

test("recognizes only the Codex models with an advertised Fast tier", () => {
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-5.4" }), true);
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-5.6-sol" }), true);
  assert.equal(supportsFastMode({ provider: "openai-codex", id: "gpt-5.4-mini" }), false);
  assert.equal(supportsFastMode({ provider: "openai", id: "gpt-5.4" }), false);
});

test("adds Codex priority processing without mutating the original payload", () => {
  const payload = { model: "gpt-5.4", input: [] };
  const updated = applyFastMode(payload, { provider: "openai-codex", id: "gpt-5.4" });

  assert.deepEqual(updated, { ...payload, service_tier: FAST_SERVICE_TIER });
  assert.deepEqual(payload, { model: "gpt-5.4", input: [] });
  assert.deepEqual(
    applyFastMode(payload, { provider: "openai-codex", id: "gpt-5.4-mini" }),
    payload,
  );
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

test.after(async () => {
  await rm(agentDir, { recursive: true, force: true });
});
