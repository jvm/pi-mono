import test from "node:test";
import assert from "node:assert/strict";

process.env.CI = "1";

const { default: piGoal } = await import("../extensions/pi-goal/index.ts");

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const renderers = new Map();
  const entries = [];
  const messages = [];
  return {
    handlers,
    commands,
    tools,
    renderers,
    entries,
    messages,
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: (name, options) => commands.set(name, options),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerMessageRenderer: (type, renderer) => renderers.set(type, renderer),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, id: `e${entries.length}`, timestamp: data?.at ?? new Date().toISOString(), data }),
    sendMessage: (message, options) => messages.push({ message, options }),
  };
}

function makeCtx(branch = []) {
  return {
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch },
    ui: {
      notifications: [],
      statuses: new Map(),
      widgets: new Map(),
      notify(message, type = "info") { this.notifications.push({ message, type }); },
      setStatus(key, value) { this.statuses.set(key, value); },
      setWidget(key, value) { this.widgets.set(key, value); },
    },
  };
}

test("extension registers command, tools, renderers, and lifecycle handlers", () => {
  const pi = makePi();
  piGoal(pi);
  assert.ok(pi.commands.has("goal"));
  assert.ok(pi.tools.has("get_goal"));
  assert.ok(pi.tools.has("create_goal"));
  assert.ok(pi.tools.has("update_goal"));
  assert.ok(pi.renderers.has("pi-goal-summary"));
  assert.ok(pi.renderers.has("pi-goal-event"));
  for (const event of ["session_start", "session_tree", "message_end", "turn_end", "agent_end", "context", "session_shutdown"]) {
    assert.ok(pi.handlers.has(event), `missing ${event}`);
  }
});

test("session_start reconstructs branch goal and context handler prunes stale contexts", async () => {
  const pi = makePi();
  piGoal(pi);
  const create = { schemaVersion: 1, kind: "create", goalId: "g1", objective: "ship", at: new Date().toISOString() };
  const branch = [{ type: "custom", customType: "pi-goal", id: "c1", timestamp: create.at, data: create }];
  const ctx = makeCtx(branch);
  await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(ctx.ui.statuses.get("pi-goal"), "Pursuing goal");

  const contextEvent = {
    type: "context",
    messages: [
      { role: "custom", customType: "pi-goal-context", details: { goalId: "g1", n: 1 } },
      { role: "user", content: "hi" },
      { role: "custom", customType: "pi-goal-context", details: { goalId: "g1", n: 2 } },
    ],
  };
  const result = await pi.handlers.get("context")[0](contextEvent, ctx);
  assert.deepEqual(result.messages.map((m) => m.role), ["user", "custom"]);
  assert.equal(result.messages[1].details.n, 2);
});

test("provider 429 transitions active goal to usage_limited", async () => {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("ship", ctx);
  await pi.handlers.get("after_provider_response")[0]({ type: "after_provider_response", status: 429, headers: {} }, ctx);
  assert.equal(pi.entries.at(-1).data.status, "usage_limited");
  assert.match(ctx.ui.statuses.get("pi-goal"), /usage limits/);
});

test("session_shutdown persists active elapsed time and clears UI", async () => {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("ship", ctx);
  await pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" }, ctx);
  assert.equal(pi.entries.at(-1).data.kind, "status");
  assert.equal(pi.entries.at(-1).data.status, "active");
  assert.equal(ctx.ui.statuses.get("pi-goal"), undefined);
  assert.equal(ctx.ui.widgets.get("pi-goal"), undefined);
});
