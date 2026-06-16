import test from "node:test";
import assert from "node:assert/strict";

process.env.CI = "1";

const { default: piGoal } = await import("../extensions/index.ts");

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

test("provider 429 notifies the agent so it can wrap up", async () => {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("ship", ctx);
  await pi.handlers.get("after_provider_response")[0]({ type: "after_provider_response", status: 429, headers: {} }, ctx);
  const sent = pi.messages.at(-1).message;
  assert.match(sent.content, /provider_limit/);
  assert.equal(sent.display, true);
  assert.equal(sent.details.kind, "provider_limit");
  assert.equal(pi.messages.at(-1).options.triggerTurn, true);
});

test("assistant usage-limit error transitions active goal to usage_limited", async () => {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("ship", ctx);
  await pi.handlers.get("message_end")[0]({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: '429 {"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 3hr 9min."}}' } }, ctx);
  assert.equal(pi.entries.at(-1).data.status, "usage_limited");
  assert.match(ctx.ui.notifications.at(-1).message, /resets in 3hr 9min/);
});

test("repeated assistant errors pause active goal", async () => {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("ship", ctx);
  const handler = pi.handlers.get("message_end")[0];
  await handler({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } }, ctx);
  await handler({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } }, ctx);
  await handler({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } }, ctx);
  assert.equal(pi.entries.at(-1).data.status, "usage_limited");
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

test("budget exceeded transitions active goal to budget_limited and notifies the agent", async () => {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("--budget 100 ship feature", ctx);
  const beforeNotify = pi.messages.length;
  const branch = [
    { type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", usage: { totalTokens: 250 } } },
  ];
  ctx.sessionManager.getBranch = () => branch;
  await pi.handlers.get("message_end")[0]({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 250 } } }, ctx);
  assert.equal(pi.entries.at(-1).data.status, "budget_limited");
  assert.match(ctx.ui.notifications.at(-1).message, /budget reached/i);
  assert.equal(pi.messages.length, beforeNotify + 1, "agent should receive a wrap-up message on budget overflow");
  const sent = pi.messages.at(-1).message;
  assert.equal(sent.display, true);
  assert.match(sent.content, /budget_exceeded/);
  assert.match(sent.content, /100/);
  assert.match(sent.content, /250/);
  assert.match(sent.content, /update_goal/);
  assert.equal(sent.details.kind, "budget_exceeded");
  assert.equal(sent.details.tokensUsed, 250);
  assert.equal(sent.details.tokenBudget, 100);
  assert.equal(pi.messages.at(-1).options.triggerTurn, true);
  assert.equal(ctx.ui.statuses.get("pi-goal"), "Goal unmet (250/100)");
});

test("budget exceeded at turn_end and agent_end also notifies the agent", async () => {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("--budget 50 ship feature", ctx);
  const beforeNotify = pi.messages.length;
  const branch = [
    { type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", usage: { totalTokens: 200 } } },
  ];
  ctx.sessionManager.getBranch = () => branch;
  await pi.handlers.get("turn_end")[0]({ type: "turn_end" }, ctx);
  assert.equal(pi.entries.at(-1).data.status, "budget_limited");
  assert.equal(pi.messages.length, beforeNotify + 1, "agent should receive exactly one wrap-up message");
  assert.match(pi.messages.at(-1).message.content, /budget_exceeded/);
  // Subsequent turn_end calls must not stack up additional wrap-up messages
  // because the goal is no longer active.
  await pi.handlers.get("turn_end")[0]({ type: "turn_end" }, ctx);
  assert.equal(pi.messages.length, beforeNotify + 1, "subsequent turn_end events must not re-notify the agent");
});

test("budget overflow notification is not sent when no assistant usage has been accounted", async () => {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("--budget 100 ship feature", ctx);
  const beforeNotify = pi.messages.length;
  // No assistant entries after the goal, so the budget cannot be exceeded
  // by any new accounting run.
  await pi.handlers.get("message_end")[0]({ type: "message_end", message: { role: "user", content: "ok" } }, ctx);
  assert.equal(pi.messages.length, beforeNotify, "agent should not be notified when the budget is not exceeded");
  assert.equal(pi.entries.find((e) => e.data.kind === "status" && e.data.status === "budget_limited"), undefined);
});
