import test from "node:test";
import assert from "node:assert/strict";

process.env.CI = "1";

const { default: piGoal } = await import("../extensions/index.ts");
const { reconstructGoalState } = await import("../src/state.ts");
const { realizedTimeUsed } = await import("../src/utils.ts");

// Exercises the registered /goal command and lifecycle handlers, not helpers.
function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const messages = [];
  return {
    handlers,
    commands,
    tools,
    entries,
    messages,
    on: (event, handler) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
    registerCommand: (name, options) => commands.set(name, options),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerMessageRenderer: () => {},
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, id: `e${entries.length}`, timestamp: data?.at ?? new Date().toISOString(), data }),
    sendMessage: (message, options) => messages.push({ message, options }),
  };
}

function makeCtx(branch) {
  return {
    mode: "print",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch, getSessionId: () => "fixture", getLeafId: () => branch.at(-1)?.id ?? null },
    ui: {
      notifications: [],
      notify(message, type = "info") { this.notifications.push({ message, type }); },
      setStatus() {},
      setWidget() {},
      confirm: async () => true,
      editor: async (_title, prefill) => `${prefill} edited`,
    },
  };
}

const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
const create = (at, tokenBudget) => ({ schemaVersion: 1, kind: "create", goalId: "g", objective: "ship", tokenBudget, at });
const status = (value, timeUsedSeconds, at) => ({ schemaVersion: 1, kind: "status", goalId: "g", status: value, timeUsedSeconds, at });

/** Start a session whose branch already holds the given goal mutations; new entries join the branch. */
async function session(mutations, extra = []) {
  const pi = makePi();
  piGoal(pi);
  const branch = [...mutations.map((data, index) => ({ type: "custom", customType: "pi-goal", id: `m${index}`, timestamp: data.at, data })), ...extra];
  const ctx = makeCtx(branch);
  const append = pi.appendEntry;
  pi.appendEntry = (customType, data) => {
    append(customType, data);
    branch.push(pi.entries.at(-1));
  };
  await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
  const goal = async () => (await pi.tools.get("get_goal").execute("", {}, undefined, undefined, ctx)).details.goal;
  const command = (args) => pi.commands.get("goal").handler(args, ctx);
  const close = () => pi.handlers.get("session_shutdown")[0]({}, ctx);
  const reloaded = () => reconstructGoalState(branch);
  return { pi, ctx, goal, command, close, reloaded, branch };
}

test("/goal edit preserves elapsed time in every source status and after reload", async () => {
  for (const [label, mutations, minimum, expected] of [
    ["active", (at) => [create(at)], 3600, "active"],
    ["paused", (at) => [create(at), status("paused", 1800, at)], 1800, "paused"],
    ["complete", (at) => [create(at), status("complete", 1800, at)], 1800, "active"],
    ["budget_limited", (at) => [create(at, 10), status("budget_limited", 1800, at)], 1800, "active"],
  ]) {
    const s = await session(mutations(hourAgo()));
    await s.command("edit");
    const goal = await s.goal();
    assert.equal(goal.status, expected, label);
    assert.match(goal.objective, /edited$/, label);
    assert.ok(goal.timeUsedSeconds >= minimum && goal.timeUsedSeconds < minimum + 60, `${label}: ${goal.timeUsedSeconds}`);
    assert.ok(realizedTimeUsed(s.reloaded()) >= minimum, `${label} reload: ${realizedTimeUsed(s.reloaded())}`);
    await s.close();
  }
});

test("/goal rejects option-only and malformed budget input without creating a goal", async () => {
  for (const [args, pattern] of [
    ["--budget 50000", /Missing objective.*--budget <tokens> <objective>/],
    ["--budget", /Usage: \/goal --budget <tokens> <objective>/],
    ["--budget=50k", /Missing objective/],
    ["--budget 0 ship it", /positive whole number/],
    ["--budget -5 ship it", /positive whole number/],
    ["--budget lots ship it", /positive whole number/],
    ["--budget 1.2345k ship it", /positive whole number/],
    ["--budgte 5 ship it", /Unknown option "--budgte"/],
    ["--help", /Unknown option "--help"/],
  ]) {
    const s = await session([]);
    await s.command(args);
    assert.equal(await s.goal(), null, args);
    assert.equal(s.pi.entries.length, 0, args);
    assert.match(s.ctx.ui.notifications.at(-1).message, pattern, args);
    assert.equal(s.ctx.ui.notifications.at(-1).type, "error", args);
  }
});

test("/goal budgets accept k/m suffixes and separators on create and update", async () => {
  for (const [args, expected] of [["--budget 50k ship it", 50_000], ["--budget=1.5m ship it", 1_500_000], ["--budget 50,000 ship it", 50_000], ["--budget 2K ship it", 2_000]]) {
    const s = await session([]);
    await s.command(args);
    const goal = await s.goal();
    assert.equal(goal.tokenBudget, expected, args);
    assert.equal(goal.objective, "ship it", args);
  }
  const s = await session([create(new Date().toISOString(), 10)]);
  await s.command("budget 50k");
  assert.equal((await s.goal()).tokenBudget, 50_000);
  for (const [args, pattern] of [["budget", /Usage: \/goal budget <tokens>/], ["budget -1", /positive whole number/], ["budget 0", /positive whole number/], ["budget ten", /positive whole number/]]) {
    const before = s.pi.entries.length;
    await s.command(args);
    assert.equal(s.pi.entries.length, before, args);
    assert.match(s.ctx.ui.notifications.at(-1).message, pattern, args);
  }
  assert.equal((await s.goal()).tokenBudget, 50_000);
});

async function budgetLimitedSession(t) {
  const at = new Date(Date.now() - 60_000).toISOString();
  const usage = { type: "message", id: "a1", timestamp: new Date(Date.now() - 30_000).toISOString(), message: { role: "assistant", usage: { totalTokens: 20 } } };
  const s = await session([create(at, 10)], [usage]);
  assert.equal((await s.goal()).status, "budget_limited", "fixture starts over budget");
  return s;
}

const continuations = (s) => s.pi.messages.filter(({ message }) => message.customType === "pi-goal-context");

test("raising or clearing the budget of a budget-limited goal resumes it and schedules continuation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const args of ["budget 50", "budget 1k", "budget clear"]) {
    const s = await budgetLimitedSession(t);
    const time = (await s.goal()).timeUsedSeconds;
    await s.command(args);
    const goal = await s.goal();
    assert.equal(goal.status, "active", args);
    assert.ok(goal.timeUsedSeconds >= time && goal.timeUsedSeconds < time + 5, `${args}: elapsed time is kept`);
    assert.equal(s.reloaded().status, "active", `${args}: resume is persisted`);
    assert.match(s.ctx.ui.notifications.at(-1).message, /Goal resumed\./, args);
    t.mock.timers.tick(1);
    assert.equal(continuations(s).length, 1, `${args}: one continuation`);
    assert.equal(continuations(s)[0].options.triggerTurn, true);
    await s.close();
  }
});

test("a budget still at or below usage keeps the goal budget-limited", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const args of ["budget 15", "budget 20"]) {
    const s = await budgetLimitedSession(t);
    await s.command(args);
    assert.equal((await s.goal()).status, "budget_limited", args);
    t.mock.timers.tick(1);
    assert.equal(continuations(s).length, 0, args);
    await s.close();
  }
});

test("/goal pause rejects goals that are not running and leaves their state unchanged", async () => {
  for (const [state, pattern] of [
    ["complete", /complete and cannot be paused/],
    ["paused", /already paused/],
    ["blocked", /blocked and is not running/],
    ["usage_limited", /usage limited and is not running/],
    ["budget_limited", /budget limited and is not running/],
  ]) {
    const at = new Date().toISOString();
    const s = await session([create(at, 10), status(state, 5, at)]);
    const before = s.pi.entries.length;
    await s.command("pause");
    assert.equal((await s.goal()).status, state, state);
    assert.equal(s.pi.entries.length, before, `${state}: nothing persisted`);
    assert.match(s.ctx.ui.notifications.at(-1).message, pattern, state);
    assert.equal(s.ctx.ui.notifications.at(-1).type, "error", state);
  }
});

test("/goal resume rejects complete goals and exhausted budgets but resumes stopped goals", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const at = new Date().toISOString();
  const complete = await session([create(at), status("complete", 5, at)]);
  await complete.command("resume");
  assert.equal((await complete.goal()).status, "complete");
  assert.match(complete.ctx.ui.notifications.at(-1).message, /Goal is complete/);

  const exhausted = await budgetLimitedSession(t);
  await exhausted.command("resume");
  assert.equal((await exhausted.goal()).status, "budget_limited");
  assert.match(exhausted.ctx.ui.notifications.at(-1).message, /budget is exhausted \(20\/10 tokens\)/);
  // Editing the objective must not reactivate a goal whose budget is still exhausted.
  await exhausted.command("edit");
  assert.equal((await exhausted.goal()).status, "budget_limited");
  t.mock.timers.tick(1);
  assert.equal(continuations(exhausted).length, 0);

  for (const state of ["paused", "blocked", "usage_limited"]) {
    const s = await session([create(at), status(state, 5, at)]);
    await s.command("resume");
    assert.equal((await s.goal()).status, "active", state);
    t.mock.timers.tick(1);
    assert.equal(continuations(s).length, 1, state);
    await s.close();
  }
});

test("update_goal finalizes active, paused, and limited goals", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const source of ["active", "paused", "usage_limited", "budget_limited"]) {
    for (const target of ["complete", "blocked"]) {
      const at = new Date().toISOString();
      const s = await session(source === "active" ? [create(at, 1000)] : [create(at, 1000), status(source, 5, at)]);
      const result = await s.pi.tools.get("update_goal").execute(`${source}-${target}`, { status: target }, undefined, undefined, s.ctx);
      assert.equal(result.details.goal.status, target, `${source} -> ${target}`);
      assert.equal(s.reloaded().status, target, `${source} -> ${target} persisted`);
      t.mock.timers.tick(1);
      assert.equal(continuations(s).length, 0, `${source} -> ${target}: no continuation`);
      await s.close();
    }
  }
});

test("update_goal rejects changes to a finalized goal and leaves it unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const source of ["complete", "blocked"]) {
    for (const target of ["complete", "blocked"]) {
      const at = new Date().toISOString();
      const s = await session([create(at), status(source, 5, at)]);
      const before = s.pi.entries.length;
      const messages = s.pi.messages.length;
      await assert.rejects(
        () => s.pi.tools.get("update_goal").execute(`${source}-${target}`, { status: target }, undefined, undefined, s.ctx),
        new RegExp(`Goal is already ${source}; update_goal cannot change a finalized goal to ${target}\\. The goal state is unchanged\\. Do not call update_goal again`),
      );
      assert.equal(s.pi.entries.length, before, `${source} -> ${target}: nothing persisted`);
      assert.equal(s.pi.messages.length, messages, `${source} -> ${target}: no goal event`);
      assert.equal((await s.goal()).status, source);
      t.mock.timers.tick(1);
      assert.equal(continuations(s).length, 0, `${source} -> ${target}: no continuation`);
      await s.close();
    }
  }
});

test("a legacy active edit entry no longer erases the accrued active segment on reload", () => {
  const at = hourAgo();
  const branch = [create(at), { schemaVersion: 1, kind: "edit", goalId: "g", objective: "next", status: "active", at: new Date().toISOString() }]
    .map((data, index) => ({ type: "custom", customType: "pi-goal", id: `m${index}`, data }));
  assert.ok(realizedTimeUsed(reconstructGoalState(branch)) >= 3600);
});
