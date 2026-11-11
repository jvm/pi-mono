import test from "node:test";
import assert from "node:assert/strict";

process.env.CI = "1";

const { default: piGoal } = await import("../extensions/index.ts");

// Drives the registered lifecycle handlers in the order Pi dispatches them for
// one provider attempt: after_provider_response, message_end, turn_end, agent_end.
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

function makeCtx() {
  return {
    mode: "print",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [], getSessionId: () => "fixture", getLeafId: () => null },
    ui: {
      notifications: [],
      notify(message, type = "info") { this.notifications.push({ message, type }); },
      setStatus() {},
      setWidget() {},
      confirm: async () => true,
    },
  };
}

async function fixture() {
  const pi = makePi();
  piGoal(pi);
  const ctx = makeCtx();
  await pi.commands.get("goal").handler("ship", ctx);
  const emit = async (event, payload = {}) => {
    for (const handler of pi.handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  };
  const assistant = (fields = {}) => ({ role: "assistant", provider: "fixture-a", model: "model-1", content: [], ...fields });
  /** One provider attempt; Pi decides afterwards whether to retry it. */
  const attempt = async ({ status = 200, headers = {}, errorMessage, provider, model } = {}) => {
    await emit("after_provider_response", { status, headers });
    const message = assistant({ ...errorMessage ? { stopReason: "error", errorMessage } : { stopReason: "stop" }, ...provider ? { provider } : {}, ...model ? { model } : {} });
    await emit("message_end", { message });
    await emit("turn_end", { message, toolResults: [] });
    await emit("agent_end", { messages: [message] });
    return message;
  };
  /** Pi gave up: retries are exhausted or the error is not retryable. */
  const settle = (outcome) => emit("agent_before_settle", { outcome, entries: [], context: { pendingMessages: [], canContinue: false } });
  const failedRun = async (options) => {
    await attempt(options);
    await settle("error");
  };
  const goal = async () => (await pi.tools.get("get_goal").execute("", {}, undefined, undefined, ctx)).details.goal;
  return { pi, ctx, emit, attempt, settle, failedRun, goal };
}

test("billing words in headers, URLs, and successful responses are not limit evidence", async () => {
  const f = await fixture();
  await f.attempt({ status: 200, headers: { "x-billing-project": "fixture", link: "<https://billing.example/usage>; rel=help", "x-ratelimit-limit-requests": "500" } });
  assert.equal((await f.goal()).status, "active");
  await f.failedRun({ status: 500, headers: { "x-billing-region": "eu" }, errorMessage: "Request to https://billing-proxy.example/v1/responses failed, reason: socket hang up" });
  assert.equal((await f.goal()).status, "active");
  assert.ok(!f.pi.entries.some(({ data }) => data.status === "usage_limited"));
});

test("real billing and quota errors still mark the goal usage-limited", async () => {
  for (const errorMessage of [
    "Your credit balance is too low to access the API. Please go to Plans & Billing to upgrade or purchase credits.",
    '429 {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}',
    '400 {"error":{"code":"billing_hard_limit_reached","message":"Billing hard limit has been reached"}}',
  ]) {
    const f = await fixture();
    await f.failedRun({ status: 400, errorMessage });
    assert.equal((await f.goal()).status, "usage_limited", errorMessage);
  }
});
