import test from "node:test";
import assert from "node:assert/strict";
import { handleGoalCommand, registerGoalTools, GoalContinuationScheduler, filterGoalContextMessages } from "../src/index.ts";

function makeCtx(branch = []) {
  const notifications = [];
  return {
    notifications,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message, type = "info") => notifications.push({ message, type }),
      confirm: async () => true,
      editor: async (_title, prefill) => `${prefill} edited`,
      setStatus: () => {},
      setWidget: () => {},
    },
  };
}

function makePi() {
  const entries = [];
  const messages = [];
  const tools = new Map();
  return {
    entries,
    messages,
    tools,
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendMessage: (message, options) => messages.push({ message, options }),
    registerTool: (tool) => tools.set(tool.name, tool),
  };
}

function makeCommandRuntime(initial = null) {
  let goal = initial;
  const events = [];
  const schedules = [];
  return {
    events,
    schedules,
    getGoal: () => goal,
    setGoal: (next) => { goal = next; },
    afterGoalChanged: (_ctx, event) => { if (event) events.push(event); },
    scheduleContinuation: (_ctx, reason) => schedules.push(reason),
  };
}

test("/goal creates, pauses, resumes, budgets, and clears", async () => {
  const pi = makePi();
  const ctx = makeCtx();
  const runtime = makeCommandRuntime();

  await handleGoalCommand(pi, "--budget 100 build feature", ctx, runtime);
  assert.equal(runtime.getGoal().objective, "build feature");
  assert.equal(runtime.getGoal().tokenBudget, 100);
  assert.deepEqual(runtime.schedules, ["created"]);

  await handleGoalCommand(pi, "pause", ctx, runtime);
  assert.equal(runtime.getGoal().status, "paused");

  await handleGoalCommand(pi, "resume", ctx, runtime);
  assert.equal(runtime.getGoal().status, "active");
  assert.equal(runtime.schedules.at(-1), "resumed");

  await handleGoalCommand(pi, "budget 10", ctx, runtime);
  assert.equal(runtime.getGoal().tokenBudget, 10);

  await handleGoalCommand(pi, "budget clear", ctx, runtime);
  assert.equal(runtime.getGoal().tokenBudget, undefined);

  await handleGoalCommand(pi, "clear", ctx, runtime);
  assert.equal(runtime.getGoal(), null);
  assert.equal(pi.entries.at(-1).data.kind, "clear");
});

test("/goal replacement requires confirmation for non-terminal goals", async () => {
  const pi = makePi();
  const ctx = makeCtx();
  const runtime = makeCommandRuntime();
  await handleGoalCommand(pi, "first", ctx, runtime);
  ctx.ui.confirm = async () => false;
  await handleGoalCommand(pi, "second", ctx, runtime);
  assert.equal(runtime.getGoal().objective, "first");
});

test("/goal edit reactivates completed goals", async () => {
  const pi = makePi();
  const ctx = makeCtx();
  const runtime = makeCommandRuntime();
  await handleGoalCommand(pi, "first", ctx, runtime);
  runtime.setGoal({ ...runtime.getGoal(), status: "complete", activeStartedAt: undefined });
  await handleGoalCommand(pi, "edit", ctx, runtime);
  assert.equal(runtime.getGoal().status, "active");
  assert.match(runtime.getGoal().objective, /edited$/);
});

test("goal tools expose create/get/update behavior", async () => {
  const pi = makePi();
  let goal = null;
  const runtime = {
    getGoal: () => goal,
    setGoal: (next) => { goal = next; },
    afterGoalChanged: () => {},
    clearContinuation: () => {},
  };
  registerGoalTools(pi, runtime);
  const ctx = makeCtx();

  let result = await pi.tools.get("get_goal").execute("1", {}, undefined, undefined, ctx);
  assert.equal(result.details.goal, null);

  result = await pi.tools.get("create_goal").execute("2", { objective: "ship", token_budget: 50 }, undefined, undefined, ctx);
  assert.equal(result.details.goal.objective, "ship");
  assert.equal(goal.status, "active");

  await assert.rejects(() => pi.tools.get("create_goal").execute("3", { objective: "again" }, undefined, undefined, ctx), /already exists/);

  result = await pi.tools.get("update_goal").execute("4", { status: "complete" }, undefined, undefined, ctx);
  assert.equal(result.details.goal.status, "complete");
  assert.equal(result.terminate, true);
});

test("update_goal accounts current branch usage before terminal transition", async () => {
  const pi = makePi();
  let goal = null;
  const runtime = { getGoal: () => goal, setGoal: (next) => { goal = next; }, afterGoalChanged: () => {}, clearContinuation: () => {} };
  registerGoalTools(pi, runtime);
  const createCtx = makeCtx();
  await pi.tools.get("create_goal").execute("1", { objective: "ship" }, undefined, undefined, createCtx);
  const branch = [
    ...pi.entries.map((entry, i) => ({ type: "custom", customType: entry.customType, id: `c${i}`, timestamp: entry.data.at, data: entry.data })),
    { type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", usage: { totalTokens: 12 } } },
  ];
  const result = await pi.tools.get("update_goal").execute("2", { status: "blocked" }, undefined, undefined, makeCtx(branch));
  assert.equal(result.details.goal.tokensUsed, 12);
  assert.equal(result.details.goal.status, "blocked");
});

test("scheduler sends one hidden goal continuation when idle", async () => {
  const pi = makePi();
  const goal = { goalId: "g1", objective: "ship", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activeStartedAt: new Date().toISOString(), accountedUsage: { tokens: 0, entryIds: [] } };
  const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal });
  scheduler.schedule(makeCtx(), "continue");
  scheduler.schedule(makeCtx(), "continue");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].message.customType, "pi-goal-context");
  assert.equal(pi.messages[0].message.display, false);
  assert.equal(pi.messages[0].options.triggerTurn, true);
});

test("scheduler does not continue with pending user messages", async () => {
  const pi = makePi();
  const goal = { goalId: "g1", objective: "ship", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activeStartedAt: new Date().toISOString(), accountedUsage: { tokens: 0, entryIds: [] } };
  const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal });
  const ctx = { ...makeCtx(), hasPendingMessages: () => true };
  scheduler.schedule(ctx, "continue");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pi.messages.length, 0);
});

test("context filter keeps only newest current goal context", () => {
  const goal = { goalId: "g2", status: "active" };
  const messages = [
    { role: "custom", customType: "pi-goal-context", details: { goalId: "g1" } },
    { role: "custom", customType: "pi-goal-context", details: { goalId: "g2", n: 1 } },
    { role: "user", content: "hello" },
    { role: "custom", customType: "pi-goal-context", details: { goalId: "g2", n: 2 } },
  ];
  const filtered = filterGoalContextMessages(messages, goal);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].role, "user");
  assert.equal(filtered[1].details.n, 2);
  assert.deepEqual(filterGoalContextMessages(messages, null), [{ role: "user", content: "hello" }]);
});
