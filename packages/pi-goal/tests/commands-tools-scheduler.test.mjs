import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { handleGoalCommand, registerGoalTools, GoalContinuationScheduler, filterGoalContextMessages } from "../src/index.ts";

function makeCtx(branch = []) {
  const notifications = [];
  return {
    notifications,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch, getSessionId: () => "fixture", getLeafId: () => branch.at(-1)?.id ?? null },
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

test("goal tools declare and return nullable/optional summaries without private accounting state", async () => {
  const pi = makePi();
  const runtime = makeCommandRuntime();
  registerGoalTools(pi, runtime);
  const get = pi.tools.get("get_goal");
  const create = pi.tools.get("create_goal");
  assert.equal(get.executionMode, "sequential");
  assert.equal(get.annotations.readOnlyHint, false);
  const empty = await get.execute("empty", {}, undefined, undefined, makeCtx());
  assert.deepEqual(empty.structuredContent, { goal: null });
  assert.ok(Check(get.outputSchema, empty.structuredContent));
  const created = await create.execute("created", { objective: "fixture" }, undefined, undefined, makeCtx());
  assert.ok(Check(create.outputSchema, created.structuredContent));
  assert.equal(created.structuredContent.goal.tokenBudget, undefined);
  assert.equal(created.structuredContent.goal.accountedUsage, undefined);
  assert.deepEqual(JSON.parse(created.content[0].text), created.structuredContent);
  // Legacy oversized goals remain inspectable, not truncated or forced active.
  runtime.setGoal({ ...runtime.getGoal(), objective: "x".repeat(4001), status: "paused" });
  const legacy = await get.execute("legacy", {}, undefined, undefined, makeCtx());
  assert.ok(Check(get.outputSchema, legacy.structuredContent));
  assert.equal(legacy.structuredContent.goal.objective.length, 4001);
  assert.equal(pi.tools.get("update_goal").outputSchema, undefined);
  assert.equal(pi.tools.get("update_goal").exposure, "model-only");
});

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

test("/goal resume preserves elapsed time for an already-active goal", async () => {
  const pi = makePi();
  const ctx = makeCtx();
  const startedAt = new Date(Date.now() - 100_000).toISOString();
  const goal = {
    goalId: "g1",
    objective: "ship",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 7,
    createdAt: startedAt,
    updatedAt: startedAt,
    activeStartedAt: startedAt,
    accountedUsage: { tokens: 0, entryIds: [] },
  };
  const runtime = makeCommandRuntime(goal);

  await handleGoalCommand(pi, "resume", ctx, runtime);

  const resumed = runtime.getGoal();
  const mutation = pi.entries.at(-1).data;
  assert.ok(resumed.timeUsedSeconds >= 106, `expected at least 106 seconds, got ${resumed.timeUsedSeconds}`);
  assert.equal(mutation.meta.time.elapsedDeltaSeconds, resumed.timeUsedSeconds - 7);
  assert.equal(mutation.meta.time.realizedTimeUsedSeconds, resumed.timeUsedSeconds);
  assert.equal(resumed.activeStartedAt, mutation.meta.time.endedAt);
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
  assert.equal(pi.tools.get("update_goal").exposure, "model-only");
  assert.equal(pi.tools.get("get_goal").exposure, undefined);
  assert.equal(pi.tools.get("create_goal").exposure, undefined);
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
    { type: "message", id: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [
      { type: "toolCall", id: "2", name: "update_goal", arguments: { status: "blocked" } },
    ] } },
  ];
  const result = await pi.tools.get("update_goal").execute("2", { status: "blocked", verification: { summary: "blocked after retries", checked_requirements: ["network"], commands: ["npm test"], worktree_status: "dirty" } }, undefined, undefined, makeCtx(branch));
  assert.equal(result.details.goal.tokensUsed, 12);
  assert.equal(result.details.goal.status, "blocked");
  const status = pi.entries.at(-1).data;
  assert.equal(status.meta.source, "tool:update_goal:blocked");
  assert.equal(status.meta.trigger.messageId, "assistant");
  assert.equal(status.meta.verification.summary, "blocked after retries");
  assert.equal(status.meta.verification.checkedRequirements[0], "network");
});

test("completion budget report includes finalized tool and summary usage", async () => {
  const pi = makePi();
  let goal = null;
  registerGoalTools(pi, {
    getGoal: () => goal, setGoal: (next) => { goal = next; }, afterGoalChanged() {}, clearContinuation() {},
  });
  await pi.tools.get("create_goal").execute("create", { objective: "fixture", token_budget: 1000 }, undefined, undefined, makeCtx());
  const at = new Date().toISOString();
  const branch = [
    { type: "message", id: "assistant", timestamp: at, message: { role: "assistant", usage: { totalTokens: 22 } } },
    { type: "message", id: "tool", timestamp: at, message: { role: "toolResult", usage: { totalTokens: 500 } } },
    { type: "compaction", id: "summary", timestamp: at, usage: { totalTokens: 10 } },
  ];
  const result = await pi.tools.get("update_goal").execute("finish", { status: "complete" }, undefined, undefined, makeCtx(branch));
  assert.equal(result.details.goal.tokensUsed, 532);
  assert.equal(result.details.goal.remainingTokens, 468);
  assert.equal(result.details.report, "Completion budget report: used 532/1000 tokens; remaining 468.");
});

test("update_goal rejects mixed verification and terminal tool calls in one turn", async () => {
  const pi = makePi();
  let goal = null;
  const runtime = { getGoal: () => goal, setGoal: (next) => { goal = next; }, afterGoalChanged: () => {}, clearContinuation: () => {} };
  registerGoalTools(pi, runtime);
  await pi.tools.get("create_goal").execute("create", { objective: "ship" }, undefined, undefined, makeCtx());
  const branch = [
    { type: "message", id: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [
      { type: "toolCall", id: "verify", name: "bash", arguments: { command: "npm test" } },
      { type: "toolCall", id: "finish", name: "update_goal", arguments: { status: "complete" } },
    ] } },
  ];
  await assert.rejects(
    () => pi.tools.get("update_goal").execute("finish", { status: "complete" }, undefined, undefined, makeCtx(branch)),
    /only tool call/,
  );
  assert.equal(goal.status, "active");
});

test("scheduler sends one hidden goal activation when idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pi = makePi();
  const goal = { goalId: "g1", objective: "ship", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activeStartedAt: new Date().toISOString(), accountedUsage: { tokens: 0, entryIds: [] } };
  const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal });
  scheduler.schedule(makeCtx(), "continue");
  scheduler.schedule(makeCtx(), "continue");
  t.mock.timers.tick(1);
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].message.customType, "pi-goal-context");
  assert.equal(pi.messages[0].message.display, false);
  assert.equal(pi.messages[0].options.triggerTurn, true);
});

test("scheduler does not continue with pending user messages", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pi = makePi();
  const goal = { goalId: "g1", objective: "ship", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activeStartedAt: new Date().toISOString(), accountedUsage: { tokens: 0, entryIds: [] } };
  const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal });
  const ctx = { ...makeCtx(), hasPendingMessages: () => true };
  scheduler.schedule(ctx, "continue");
  t.mock.timers.tick(1);
  assert.equal(pi.messages.length, 0);
});

test("settlement composes drafts without vetoing another handler or duplicating goal context", () => {
  const pi = makePi();
  let goal = { goalId: "g1", objective: "ship", status: "active", tokensUsed: 0, timeUsedSeconds: 0 };
  const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal });
  const foreign = { type: "custom", customType: "another-extension", data: { retained: true } };
  const event = { entries: [foreign], continue: true, outcome: "completed", context: { canContinue: false, pendingMessages: [] } };
  const result = scheduler.beforeSettle(event, makeCtx());
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0], foreign);
  assert.equal(result.entries[1].type, "custom_message");
  assert.equal(result.entries[1].customType, "pi-goal-context");
  assert.equal(pi.messages.length, 0, "boundary proposals must not use sendMessage");
  assert.deepEqual(event.entries, [foreign], "do not mutate the upstream proposal");
  assert.deepEqual(scheduler.beforeSettle({ ...event, entries: result.entries, context: { ...event.context, canContinue: true } }, makeCtx()), { continue: true });
  for (const outcome of ["aborted", "error"]) {
    assert.equal(scheduler.beforeSettle({ ...event, outcome }, makeCtx()), undefined);
  }
  assert.equal(scheduler.beforeSettle({ ...event, context: { ...event.context, pendingMessages: [{ role: "user" }] } }, makeCtx()), undefined);
  assert.equal(scheduler.beforeSettle(event, { ...makeCtx(), signal: AbortSignal.abort() }), undefined);
  for (const status of ["paused", "complete", "blocked", "budget_limited", "usage_limited"]) {
    goal = { ...goal, status };
    assert.equal(scheduler.beforeSettle(event, makeCtx()), undefined, "declining is not continue:false");
  }
});

test("activation timers recheck identity, pending work, cancellation, and idle state", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const change of ["busy", "pending", "cancelled", "session", "branch", "goal", "paused", "cleared", "disposed"]) {
    const pi = makePi();
    let goal = { goalId: "g1", objective: "ship", status: "active", tokensUsed: 0, timeUsedSeconds: 0 };
    const ctx = makeCtx([{ id: "leaf" }]);
    const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal });
    scheduler.schedule(ctx);
    if (change === "busy") ctx.isIdle = () => false;
    if (change === "pending") ctx.hasPendingMessages = () => true;
    if (change === "cancelled") ctx.signal = AbortSignal.abort();
    if (change === "session") ctx.sessionManager.getSessionId = () => "replacement";
    if (change === "branch") ctx.sessionManager.getBranch = () => [];
    if (change === "goal") goal = { ...goal, goalId: "replacement" };
    if (change === "paused") goal = { ...goal, status: "paused" };
    if (change === "cleared") scheduler.clear();
    if (change === "disposed") ctx.isIdle = () => { throw new Error("Inactive extension runtime"); };
    t.mock.timers.tick(1);
    assert.equal(pi.messages.length, 0, change);
    assert.equal(scheduler.isScheduled(), false);
  }
});

test("boundary goal context stays bounded without truncating the objective", () => {
  const pi = makePi();
  let goal = { goalId: "g1", objective: "<".repeat(4000), status: "active", tokensUsed: 0, timeUsedSeconds: 0 };
  const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal });
  const event = { entries: [], continue: false, outcome: "completed", context: { canContinue: false, pendingMessages: [] } };
  const result = scheduler.beforeSettle(event, makeCtx());
  assert.ok(result.entries[0].content.length < 32_000);
  const encodedObjective = result.entries[0].content.match(/<objective_json>(.*?)<\/objective_json>/)[1];
  assert.equal(JSON.parse(encodedObjective), goal.objective);
  goal = { ...goal, objective: "x".repeat(4001) };
  assert.equal(scheduler.beforeSettle(event, makeCtx()), undefined, "oversized persisted data must not become an unbounded prompt");
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
