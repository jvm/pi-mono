import test from "node:test";
import assert from "node:assert/strict";

import { codexHarness, requestBody, textResponse } from "../../../tests/codex-harness.mjs";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const { default: piGoal } = await import("../extensions/index.ts");
const { reconstructGoalState } = await import("../src/state.ts");

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

const statusOf = async (f) => (await f.goal()).status;
const goalNotices = (f) => f.pi.messages.filter(({ message }) => message.customType === "pi-goal-event" && message.details?.kind);

test("issue #224: generic errors across providers pause with an accurate reason, never as usage-limited", async () => {
  const f = await fixture();
  await f.failedRun({ errorMessage: "Request timed out.", provider: "fixture-a" });
  await f.failedRun({ errorMessage: "Request timed out.", provider: "fixture-b" });
  await f.failedRun({ errorMessage: "Request timed out.", provider: "fixture-b" });
  assert.equal(await statusOf(f), "active", "switching provider restarts the streak");
  await f.failedRun({ errorMessage: "Request timed out.", provider: "fixture-b" });
  assert.equal(await statusOf(f), "paused");
  const transition = f.pi.entries.at(-1).data;
  assert.equal(transition.meta.source, "provider-error");
  assert.equal(transition.meta.providerLimit.kind, "provider_error");
  assert.match(transition.meta.providerLimit.reason, /3 consecutive runs failed on fixture-b\/model-1 after Pi's retries \(last error: "Request timed out\."\)/);
  const [notice] = goalNotices(f);
  assert.equal(notice.message.details.kind, "provider_error");
  assert.equal(notice.options.triggerTurn, false);
  assert.match(notice.message.content, /<provider_error>[\s\S]*not a confirmed usage or rate limit[\s\S]*"paused"[\s\S]*\/goal resume/);
  assert.doesNotMatch(notice.message.content, /hit a usage\/rate limit|after the limit resets|update_goal/);
  assert.match(f.ctx.ui.notifications.at(-1).message, /^Goal paused: 3 consecutive runs failed/);
  assert.doesNotMatch(f.ctx.ui.notifications.at(-1).message, /usage\/rate limit/);
});

test("switching model on the same provider also restarts the streak", async () => {
  const f = await fixture();
  await f.failedRun({ errorMessage: "terminated", model: "model-1" });
  await f.failedRun({ errorMessage: "terminated", model: "model-1" });
  await f.failedRun({ errorMessage: "terminated", model: "model-2" });
  await f.failedRun({ errorMessage: "terminated", model: "model-2" });
  assert.equal(await statusOf(f), "active");
});

test("a successful message resets the streak", async () => {
  const f = await fixture();
  await f.failedRun({ errorMessage: "terminated" });
  await f.failedRun({ errorMessage: "terminated" });
  await f.attempt();
  await f.settle("completed");
  await f.failedRun({ errorMessage: "terminated" });
  await f.failedRun({ errorMessage: "terminated" });
  assert.equal(await statusOf(f), "active");
});

test("failed attempts inside one run never pause while Pi may still retry them", async () => {
  // Pi's default retry policy is maxRetries: 3, so one run can emit four failed message_end events.
  for (const errorMessage of ["Request timed out.", "Too many requests", '429 {"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached"}}']) {
    const f = await fixture();
    const before = f.pi.entries.length;
    for (let attempt = 0; attempt < 4; attempt++) await f.attempt({ status: 429, errorMessage });
    assert.equal(f.pi.entries.length, before, `${errorMessage}: nothing persisted before settlement`);
    assert.equal(goalNotices(f).length, 0);
    await f.attempt({ status: 200 });
    await f.settle("completed");
    assert.equal(await statusOf(f), "active", `${errorMessage}: a successful retry keeps the goal running`);
    assert.equal(goalNotices(f).length, 0);
  }
});

test("a 429 from an earlier attempt is not evidence for a retry that failed before any response", async () => {
  const f = await fixture();
  await f.emit("after_provider_response", { status: 429, headers: { "retry-after": "1" } });
  await f.emit("agent_start");
  // The retry fails in transport, so no after_provider_response replaces the old evidence.
  await f.emit("message_end", { message: { role: "assistant", provider: "fixture-a", model: "model-1", stopReason: "error", errorMessage: "fetch failed" } });
  await f.settle("error");
  assert.equal(await statusOf(f), "active", "a later generic failure is not reclassified as a limit");
});

test("retry-exhausted rate limits mark the goal usage-limited with the retry hint", async () => {
  const f = await fixture();
  await f.attempt({ status: 429, headers: { "retry-after": "30" }, errorMessage: "terminated" });
  await f.failedRun({ status: 429, headers: { "retry-after": "30" }, errorMessage: "terminated" });
  assert.equal(await statusOf(f), "usage_limited");
  assert.equal(f.pi.entries.at(-1).data.meta.providerLimit.kind, "rate_limit");
  assert.match(f.ctx.ui.notifications.at(-1).message, /usage\/rate limit \(retry after 30s\)/);
});

test("authentication failures pause without claiming a usage limit", async () => {
  const f = await fixture();
  await f.failedRun({ status: 401, errorMessage: "401 Unauthorized: invalid api key" });
  assert.equal(await statusOf(f), "paused");
  assert.equal(f.pi.entries.at(-1).data.meta.providerLimit.kind, "auth_required");
  assert.match(goalNotices(f)[0].message.content, /provider authentication failed on fixture-a\/model-1/);
});

test("cancelled runs do not count as provider failures", async () => {
  const f = await fixture();
  for (let run = 0; run < 3; run++) {
    await f.attempt({ errorMessage: "terminated" });
    await f.settle("aborted");
  }
  assert.equal(await statusOf(f), "active");
});

// Real Pi runtime: the retry loop, event order, and settlement come from the host.
function errorResponse(message) {
  return new Response(`data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "fixture", message } } })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function runtime(t, retry) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network request blocked"); });
  t.mock.method(globalThis, "WebSocket", function () { throw new Error("WebSocket network request blocked"); });
  const h = await codexHarness([piGoal], { retry });
  // Keep the created goal's activation timer from starting an unscripted run.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.retries = 0;
  h.session.subscribe((event) => {
    if (event.type !== "auto_retry_start") return;
    h.retries++;
    // Release Pi's backoff sleep, which is scheduled right after this event.
    setImmediate(() => t.mock.timers.tick(event.delayMs));
  });
  t.after(async () => {
    if (reconstructGoalState(h.sessionManager.getBranch())?.status === "active") await h.session.prompt("/goal pause");
    await h.close();
  });
  await h.session.prompt("/goal Synthetic provider error fixture");
  return h;
}

function script(t, h, batch) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(requestBody(init));
    if (requests.length > batch.length) {
      queueMicrotask(() => { void h.session.abort(); });
      return errorResponse("Unexpected fixture request");
    }
    return batch[requests.length - 1]();
  });
  return requests;
}

const runtimeState = (h) => reconstructGoalState(h.sessionManager.getBranch());
const retry = { enabled: true, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 };

test("Pi's retries of a rate limit do not pause a goal whose retry succeeds", { timeout: 10_000 }, async (t) => {
  const h = await runtime(t, retry);
  const requests = script(t, h, [
    () => errorResponse("429 Too Many Requests: rate limit exceeded"),
    () => errorResponse("Request timed out."),
    () => errorResponse("Request timed out."),
    () => textResponse("Recovered."),
  ]);
  await h.session.prompt("Exercise Pi's retry loop.");
  await h.session.waitForIdle();
  assert.equal(h.retries, 3, "Pi retried every failed attempt");
  // The recovered run settles as completed, so the goal continues; the fixture
  // aborts that unscripted continuation request.
  assert.equal(requests.length, 5);
  assert.equal(runtimeState(h).status, "active");
  assert.ok(!h.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-event" && entry.details?.kind));
});

test("a run that exhausts Pi's retries counts once and is not usage-limited", { timeout: 10_000 }, async (t) => {
  const h = await runtime(t, retry);
  script(t, h, Array.from({ length: 4 }, () => () => errorResponse("Request timed out.")));
  await h.session.prompt("Exhaust Pi's retry loop.");
  await h.session.waitForIdle();
  assert.equal(h.retries, 3);
  assert.equal(runtimeState(h).status, "active", "one failed run is below the pause threshold");
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
