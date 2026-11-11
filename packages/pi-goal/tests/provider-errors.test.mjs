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
  assert.match(transition.meta.providerLimit.reason, /3 consecutive runs failed on fixture-b\/model-1 \(last error: "Request timed out\."\)/);
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

test("an HTTP 401 or 403 pauses as an authentication failure whatever the provider's wording", async () => {
  for (const [status, errorMessage] of [
    [401, '401 {"error":{"message":"Incorrect API key provided: sk-fixt*****. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}'],
    [401, '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
    [401, "401: {\"message\":\"No auth credentials found\"}"],
    [401, "terminated"],
    [403, '403 {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}'],
    [403, '403 {"error":{"code":403,"message":"Permission denied on resource project fixture.","status":"PERMISSION_DENIED"}}'],
  ]) {
    const f = await fixture();
    await f.failedRun({ status, errorMessage });
    assert.equal(await statusOf(f), "paused", errorMessage);
    const { providerLimit } = f.pi.entries.at(-1).data.meta;
    assert.equal(providerLimit.kind, "auth_required", errorMessage);
    assert.match(providerLimit.reason, /^provider (?:authentication failed|denied access) on fixture-a\/model-1/);
    assert.doesNotMatch(goalNotices(f)[0].message.content, /usage\/rate limit/);
  }
});

test("the HTTP status of the response is auth evidence when the error text carries none", async () => {
  const f = await fixture();
  // Pi reports the HTTP response, then an error whose text has no status prefix.
  await f.failedRun({ status: 401, errorMessage: "Stream closed before a response was received" });
  assert.equal(await statusOf(f), "paused");
  assert.equal(f.pi.entries.at(-1).data.meta.providerLimit.kind, "auth_required");
});

test("auth wording is a fallback only for failures without a contradicting status", async () => {
  for (const errorMessage of [
    "API key not valid. Please pass a valid API key.",
    '400 {"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
    "The security token included in the request is invalid.",
  ]) {
    const f = await fixture();
    await f.failedRun({ status: 200, errorMessage });
    assert.equal(f.pi.entries.at(-1).data.meta?.providerLimit?.kind, "auth_required", errorMessage);
  }
  // A server error that mentions authentication is a server error, and a 429 stays a limit.
  const server = await fixture();
  await server.failedRun({ status: 500, errorMessage: "500 authentication service unavailable" });
  assert.equal(await statusOf(server), "active");
  const limited = await fixture();
  await limited.failedRun({ status: 429, errorMessage: "429 Unauthorized burst: too many requests" });
  assert.equal(await statusOf(limited), "usage_limited");
  const throttled = await fixture();
  await throttled.failedRun({ status: 403, errorMessage: "403 Forbidden: rate limit exceeded" });
  assert.equal(await statusOf(throttled), "usage_limited");
});

test("a known HTTP status decides the classification over the error wording", async () => {
  // The response status and the attempt's error text are one piece of evidence.
  for (const [status, errorMessage, expected, kind] of [
    [500, "authentication failed: upstream service unavailable", "active"],
    [503, "Unauthorized gateway: invalid credentials upstream", "active"],
    [502, "usage limit reached on upstream pool", "active"],
    [500, "500 quota exceeded in internal cache", "active"],
    [404, "billing_error: model not found", "active"],
    [401, "insufficient_quota", "paused", "auth_required"],
    [403, "rate limit exceeded", "usage_limited", "rate_limit"],
    [403, "Too many requests, slow down", "usage_limited", "rate_limit"],
    [429, "authentication failed", "usage_limited", "rate_limit"],
  ]) {
    const f = await fixture();
    await f.failedRun({ status, errorMessage });
    assert.equal(await statusOf(f), expected, `${status} ${errorMessage}`);
    if (kind) assert.equal(f.pi.entries.at(-1).data.meta.providerLimit.kind, kind, `${status} ${errorMessage}`);
    else assert.match(f.ctx.ui.notifications.at(-1).message, /^Goal run failed on fixture-a\/model-1/, `${status} ${errorMessage}`);
  }
});

test("a response status is evidence only for the attempt that received it", async () => {
  const f = await fixture();
  await f.emit("after_provider_response", { status: 401, headers: {} });
  await f.emit("message_end", { message: { role: "assistant", provider: "fixture-a", model: "model-1", stopReason: "error", errorMessage: "terminated" } });
  // Pi's retry fails in transport before any response arrives.
  await f.emit("message_end", { message: { role: "assistant", provider: "fixture-a", model: "model-1", stopReason: "error", errorMessage: "fetch failed" } });
  await f.settle("error");
  assert.equal(await statusOf(f), "active");
});

test("auth evidence never comes from headers, URLs, or model IDs", async () => {
  const f = await fixture();
  await f.failedRun({
    status: 500,
    headers: { "www-authenticate": "Bearer error=\"invalid_token\"", "x-auth-unauthorized": "1" },
    errorMessage: "Request to https://unauthorized.example/invalid-api-key failed, reason: socket hang up",
    model: "unauthorized-invalid-api-key",
  });
  assert.equal(await statusOf(f), "active");
});

const continuations = (f) => f.pi.messages.filter(({ message, options }) => message.customType === "pi-goal-context" && options?.triggerTurn);

test("a failed run continues automatically with backoff and pauses when the retries are spent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  const before = continuations(f).length;
  await f.failedRun({ errorMessage: "Request timed out." });
  assert.equal(await statusOf(f), "active");
  assert.match(f.ctx.ui.notifications.at(-1).message, /^Goal run failed on fixture-a\/model-1 \(last error: "Request timed out\."\)\. Continuing automatically in 30s \(failed run 1 of 3\)\.$/);
  t.mock.timers.tick(29_999);
  assert.equal(continuations(f).length, before, "no continuation before the backoff elapses");
  t.mock.timers.tick(1);
  assert.equal(continuations(f).length, before + 1, "the goal does not wait for user input");
  await f.emit("agent_start");
  await f.failedRun({ errorMessage: "Request timed out." });
  assert.match(f.ctx.ui.notifications.at(-1).message, /Continuing automatically in 120s \(failed run 2 of 3\)/);
  t.mock.timers.tick(120_000);
  assert.equal(continuations(f).length, before + 2);
  await f.emit("agent_start");
  await f.failedRun({ errorMessage: "Request timed out." });
  assert.equal(await statusOf(f), "paused");
  assert.match(f.ctx.ui.notifications.at(-1).message, /^Goal paused: 3 consecutive runs failed on fixture-a\/model-1 \(last error: "Request timed out\."\)/);
  t.mock.timers.tick(600_000);
  assert.equal(continuations(f).length, before + 2, "no continuation after the pause");
});

test("a pending automatic retry is cancelled by a new run, a pause, or a success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  const before = continuations(f).length;
  await f.failedRun({ errorMessage: "terminated" });
  await f.emit("agent_start");
  t.mock.timers.tick(30_000);
  assert.equal(continuations(f).length, before, "a user run supersedes the retry");
  await f.attempt();
  await f.settle("completed");
  await f.failedRun({ errorMessage: "terminated" });
  assert.match(f.ctx.ui.notifications.at(-1).message, /in 30s \(failed run 1 of 3\)/, "a success restarts the backoff");
  await f.pi.commands.get("goal").handler("pause", f.ctx);
  t.mock.timers.tick(30_000);
  assert.equal(continuations(f).length, before);
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
const noRetry = { enabled: false };

async function fireRetry(t, h, delayMs) {
  t.mock.timers.tick(delayMs);
  // The retry's own run starts asynchronously from sendMessage.
  await new Promise((resolve) => setImmediate(resolve));
  await h.session.waitForIdle();
}


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
  const requests = script(t, h, Array.from({ length: 4 }, () => () => errorResponse("Request timed out.")));
  await h.session.prompt("Exhaust Pi's retry loop.");
  await h.session.waitForIdle();
  assert.equal(h.retries, 3);
  assert.equal(runtimeState(h).status, "active", "one failed run is below the pause threshold");
  assert.equal(requests.length, 4);
  // The goal is continued later, not left waiting for user input.
  await fireRetry(t, h, 30_000);
  assert.equal(requests.length, 5);
});

test("a real 401 with OpenAI's wording pauses on the first failed run", { timeout: 10_000 }, async (t) => {
  const h = await runtime(t, retry);
  script(t, h, [() => new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-fixt*****.", type: "invalid_request_error", code: "invalid_api_key" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })]);
  await h.session.prompt("Use a revoked key.");
  await h.session.waitForIdle();
  const state = runtimeState(h);
  assert.equal(state.status, "paused");
  const transition = h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-goal").at(-1);
  assert.equal(transition.data.meta.providerLimit.kind, "auth_required");
});

test("a real HTTP 500 that mentions authentication is a server error, not an auth failure", { timeout: 10_000 }, async (t) => {
  const h = await runtime(t, noRetry);
  const requests = script(t, h, [
    () => new Response(JSON.stringify({ error: { message: "authentication failed: upstream service unavailable", type: "server_error" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
    () => textResponse("Recovered."),
  ]);
  await h.session.prompt("Hit a flaky upstream.");
  await h.session.waitForIdle();
  assert.equal(runtimeState(h).status, "active", "a server error takes the delayed retry");
  await fireRetry(t, h, 30_000);
  assert.ok(requests.length >= 2, "the goal continued without user input");
});

test("with Pi's retries disabled, one transient failure continues the goal after a delay", { timeout: 10_000 }, async (t) => {
  const h = await runtime(t, noRetry);
  const requests = script(t, h, [
    () => errorResponse("Request timed out."),
    () => textResponse("Recovered."),
  ]);
  await h.session.prompt("Fail once without Pi retries.");
  await h.session.waitForIdle();
  assert.equal(h.retries, 0);
  assert.equal(requests.length, 1);
  assert.equal(runtimeState(h).status, "active");
  await fireRetry(t, h, 30_000);
  assert.ok(requests.length >= 2, "the goal continued without user input");
  assert.equal(runtimeState(h).status, "active");
});

test("a provider that keeps failing pauses the goal after bounded automatic retries", { timeout: 10_000 }, async (t) => {
  const h = await runtime(t, noRetry);
  const requests = script(t, h, Array.from({ length: 3 }, () => () => errorResponse("Request timed out.")));
  await h.session.prompt("Keep failing.");
  await h.session.waitForIdle();
  await fireRetry(t, h, 30_000);
  assert.equal(requests.length, 2);
  assert.equal(runtimeState(h).status, "active");
  await fireRetry(t, h, 120_000);
  assert.equal(requests.length, 3);
  const state = runtimeState(h);
  assert.equal(state.status, "paused");
  const transition = h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-goal").at(-1);
  assert.equal(transition.data.meta.providerLimit.kind, "provider_error");
  assert.match(transition.data.meta.providerLimit.reason, /3 consecutive runs failed on openai-codex\/gpt-6-astra \(last error: "Request timed out\."\)/);
  await fireRetry(t, h, 600_000);
  assert.equal(requests.length, 3, "no further request after the pause");
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

test("adversarial provider error text classifies in bounded time with the correct result", async () => {
  const { classifyAssistantError } = await import("../src/provider-limits.ts");
  const braces = "{{".repeat(200_000);
  const cases = [
    { errorMessage: braces, kind: "none" },
    { errorMessage: `${braces}x`, kind: "none" },
    { errorMessage: `${braces}}`, kind: "none" },
    { errorMessage: `429 {"error":{"code":"insufficient_quota"}}${braces}`, kind: "quota_exceeded" },
    { errorMessage: `5 - hour usage limit reached ${braces}`, kind: "usage_limit" },
    { errorMessage: `5${" ".repeat(200_000)}`, kind: "none" },
    { errorMessage: "a.".repeat(200_000), kind: "none" },
    { errorMessage: `${"a.".repeat(1_000)}://x see https://billing-hard-limit.example/x`, kind: "none" },
  ];
  for (const { errorMessage, kind } of cases) {
    const started = performance.now();
    const result = classifyAssistantError({ role: "assistant", stopReason: "error", errorMessage });
    const elapsed = performance.now() - started;
    assert.equal(result.kind, kind, errorMessage.slice(0, 60));
    assert.ok(elapsed < 1_000, `classification took ${Math.round(elapsed)} ms for ${errorMessage.slice(0, 60)}`);
  }

  // The same input through the extension's failure handling.
  const f = await fixture();
  const started = performance.now();
  await f.failedRun({ status: 400, errorMessage: `{"error":{"code":"insufficient_quota"}}${braces}` });
  assert.ok(performance.now() - started < 1_000);
  assert.equal((await f.goal()).status, "usage_limited");
});
