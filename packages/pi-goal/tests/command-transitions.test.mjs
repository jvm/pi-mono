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

test("a legacy active edit entry no longer erases the accrued active segment on reload", () => {
  const at = hourAgo();
  const branch = [create(at), { schemaVersion: 1, kind: "edit", goalId: "g", objective: "next", status: "active", at: new Date().toISOString() }]
    .map((data, index) => ({ type: "custom", customType: "pi-goal", id: `m${index}`, data }));
  assert.ok(realizedTimeUsed(reconstructGoalState(branch)) >= 3600);
});
