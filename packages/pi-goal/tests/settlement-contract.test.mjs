import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as checkpoint } from "node:timers/promises";
import { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { codexHarness, requestBody, textResponse } from "../../../tests/codex-harness.mjs";
import { reconstructGoalState } from "../src/state.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const { default: piGoal } = await import("../extensions/index.ts");

function eventsResponse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function errorResponse(message) {
  return eventsResponse([{ type: "response.failed", response: { status: "failed", error: { code: "fixture", message } } }]);
}

function toolResponse(name, args) {
  const item = { type: "function_call", id: `fc_${name}`, call_id: `call_${name}`, name, arguments: JSON.stringify(args) };
  return eventsResponse([
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ]);
}
const terminalResponse = (status) => toolResponse("update_goal", { status });

const state = (h) => reconstructGoalState(h.sessionManager.getBranch());
const contexts = (h) => h.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-context");
const contextCount = (request) => (JSON.stringify(request.input).match(/<goal_context reason=/g) ?? []).length;

async function harness(t, { budget = 22, before = [], after = [], retry, create = true } = {}) {
  // Block all network before loading the real runtime. The shared harness uses
  // synthetic in-memory credentials and an isolated temporary agent directory.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network request blocked"); });
  // Nested/default summarizers can select their own transport.
  t.mock.method(globalThis, "WebSocket", function () { throw new Error("WebSocket network request blocked"); });
  const h = await codexHarness([...before, piGoal, ...after], { retry });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.events = [];
  h.session.subscribe((event) => h.events.push(event));
  t.after(async () => {
    // Clear activation timers before disposing an SDK session.
    if (!h.disposed && state(h)) await h.session.prompt("/goal pause");
    await h.close();
  });
  if (create) await h.session.prompt(`/goal --budget ${budget} Synthetic settlement fixture`);
  return h;
}

for (const recovery of ["success", "failure", "cancel"]) {
  test(`overflow ${recovery} finishes before goal continuation sees the canonical projection`, { timeout: 10_000 }, async (t) => {
    const order = [];
    const previews = [];
    const compact = (pi) => {
      pi.on("session_before_compact", (event) => {
        order.push("compact");
        assert.equal(event.reason, "overflow");
        if (recovery === "cancel") return { cancel: true };
        if (recovery === "failure") return;
        return { compaction: {
          summary: "Repaired fixture context", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
          usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } };
      });
      pi.on("session_compact", () => { order.push("compacted"); });
      pi.on("session_compact_failed", () => { order.push("failed"); });
      pi.on("agent_before_settle", (event) => {
        order.push("boundary");
        previews.push(event.context);
        assert.ok(!event.context.contextMessages.some((message) => message.role === "assistant" && message.stopReason === "error"));
      });
    };
    const h = await harness(t, { before: [compact] });
    h.session.settingsManager.setCompactionEnabled(true);
    const requests = responses(t, h, [
      () => errorResponse("context_length_exceeded: prompt is too long"),
      ...recovery === "success" ? [() => textResponse("Recovered."), () => textResponse("Goal continuation.")] : recovery === "failure" ? [() => errorResponse("Invalid compaction fixture request")] : [],
    ]);
    await h.session.prompt("Exercise automatic overflow recovery.");
    await assertSettled(t, h, requests, recovery === "success" ? 3 : recovery === "failure" ? 2 : 1);
    assert.deepEqual(order.slice(0, 3), ["compact", recovery === "success" ? "compacted" : "failed", "boundary"]);
    assert.ok(h.sessionManager.getBranch().some((entry) => entry.type === "context_edit"));
    assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, recovery === "success" ? 1 : 0);
    assert.equal(contexts(h).length, recovery === "success" ? 1 : 0);
    if (recovery === "success") {
      assert.match(JSON.stringify(requests[1].input), /Repaired fixture context/);
      assert.deepEqual(requests.map(contextCount), [0, 0, 1]);
      assert.equal(state(h).tokensUsed, 27, "compaction usage is finalized before the goal decides");
    } else {
      assert.equal(previews[0].canContinue, true, "runnable repaired input is not permission to restart a failed run");
    }
  });
}

test("failed compaction after a completed response does not launch another goal request", { timeout: 10_000 }, async (t) => {
  let failed = false;
  let outcome;
  const compact = (pi) => {
    pi.on("session_before_compact", () => ({ cancel: true }));
    pi.on("session_compact_failed", () => { failed = true; });
    pi.on("agent_before_settle", (event) => { outcome = event.outcome; });
  };
  const h = await harness(t, { budget: 1_000_000_000, before: [compact] });
  h.session.settingsManager.setCompactionEnabled(true);
  const requests = responses(t, h, [async () => {
    const body = await textResponse("Completed with a large context.").text();
    return new Response(body.replace('"input_tokens":10', `"input_tokens":${h.model.contextWindow + 1}`), {
      headers: { "content-type": "text/event-stream" },
    });
  }]);
  await h.session.prompt("Exercise failed post-response compaction.");
  await assertSettled(t, h, requests, 1);
  assert.equal(failed, true);
  assert.equal(outcome, "completed");
  assert.equal(state(h).status, "active");
  assert.equal(contexts(h).length, 0);
});

test("turn-end context edits are committed before the goal boundary and history stays intact", { timeout: 10_000 }, async (t) => {
  let target;
  const repair = (pi) => {
    pi.on("turn_end", (event) => {
      if (target) return;
      target = event.messageEntryId;
      return { entries: [...event.entries, { type: "context_edit", targetId: target, replacement: { content: "Repaired fixture response" } }] };
    });
    pi.on("agent_before_settle", (event) => {
      assert.match(JSON.stringify(event.context.contextMessages), /Repaired fixture response/);
      assert.doesNotMatch(JSON.stringify(event.context.contextMessages), /Original fixture response/);
    });
  };
  const h = await harness(t, { before: [repair] });
  const requests = responses(t, h, [() => textResponse("Original fixture response"), () => textResponse()]);
  await h.session.prompt("Repair canonical context.");
  await assertSettled(t, h, requests, 2);
  assert.match(JSON.stringify(h.sessionManager.getEntry(target)), /Original fixture response/);
  assert.match(JSON.stringify(requests[1].input), /Repaired fixture response/);
});

for (const activation of ["created", "resumed", "reloaded", "tree"]) {
  test(`idle ${activation} activation still starts exactly one run`, { timeout: 10_000 }, async (t) => {
    const h = await harness(t, { budget: 11 });
    const activeLeaf = h.sessionManager.getLeafId();
    const requests = responses(t, h, [() => textResponse()]);
    if (activation === "resumed" || activation === "tree") {
      await h.session.prompt("/goal pause");
      t.mock.timers.tick(1);
      await checkpoint();
      assert.equal(requests.length, 0);
      if (activation === "resumed") await h.session.prompt("/goal resume");
      else await h.session.navigateTree(activeLeaf, { summarize: false });
    }
    if (activation === "reloaded") await h.session.reload();
    t.mock.timers.tick(1);
    await checkpoint();
    await assertSettled(t, h, requests, 1);
    assert.equal(state(h).status, "budget_limited");
    assert.equal(contexts(h).length, 1);
  });
}

for (const command of ["pause", "clear", "replace"]) {
  test(`${command} invalidates an old idle activation`, { timeout: 10_000 }, async (t) => {
    const h = await harness(t, { budget: 11 });
    const originalId = state(h).goalId;
    if (command === "replace") {
      await h.session.bindExtensions({ mode: "rpc", uiContext: { ...h.ctx.ui, confirm: async () => true } });
    }
    const requests = responses(t, h, command === "replace" ? [() => textResponse()] : []);
    await h.session.prompt(command === "replace" ? "/goal --budget 11 Replacement fixture" : `/goal ${command}`);
    t.mock.timers.tick(1);
    await checkpoint();
    await assertSettled(t, h, requests, command === "replace" ? 1 : 0);
    assert.ok(!contexts(h).some((entry) => entry.details.goalId === originalId));
    if (command === "replace") {
      assert.notEqual(state(h).goalId, originalId);
      assert.match(JSON.stringify(requests[0].input), /Replacement fixture/);
      assert.equal(state(h).status, "budget_limited");
    }
  });
}

for (const status of ["paused", "budget_limited", "usage_limited", "complete", "blocked"]) {
  test(`a ${status} goal does not veto another extension's continuation`, { timeout: 10_000 }, async (t) => {
    let proposed = false;
    const companion = (pi) => pi.on("agent_before_settle", (event) => {
      if (proposed) return;
      proposed = true;
      return { entries: [...event.entries, { type: "custom_message", customType: "fixture-companion", content: "Independent continuation", display: false }], continue: true };
    });
    const h = await harness(t, { before: [companion] });
    await h.session.prompt("/goal pause");
    const goal = state(h);
    h.sessionManager.appendCustomEntry("pi-goal", { schemaVersion: 1, kind: "status", goalId: goal.goalId, status, timeUsedSeconds: 0, at: new Date().toISOString() });
    await h.session.reload();
    const requests = responses(t, h, [() => textResponse(), () => textResponse()]);
    await h.session.prompt("Continue independently.");
    await assertSettled(t, h, requests, 2);
    assert.equal(state(h).status, status);
    assert.equal(contexts(h).length, 0);
  });
}

for (const mode of ["tui", "print", "json", "rpc"]) {
  test(`settlement continuation works with ${mode} bindings`, { timeout: 10_000 }, async (t) => {
    const h = await harness(t);
    await h.session.bindExtensions({ mode });
    const requests = responses(t, h, [() => textResponse(), () => textResponse()]);
    await h.session.prompt("Exercise mode-independent continuation.");
    await assertSettled(t, h, requests, 2);
    assert.equal(contextCount(requests[1]), 1);
  });
}

test("navigation waits for later handlers and discards the abandoned branch's activation", { timeout: 10_000 }, async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const hold = (pi) => pi.on("session_tree", async () => {
    entered.resolve();
    await release.promise;
  });
  const h = await harness(t, { budget: 11, after: [hold] });
  const activeLeaf = h.sessionManager.getBranch().find((entry) => entry.customType === "pi-goal").id;
  await h.session.prompt("/goal pause");
  const requests = responses(t, h, [() => textResponse()]);
  const navigation = h.session.navigateTree(activeLeaf, { summarize: false });
  await entered.promise;
  t.mock.timers.tick(1);
  await checkpoint();
  assert.equal(requests.length, 0, "activation must not run while navigation is still owned by Pi");
  release.resolve();
  await navigation;
  t.mock.timers.tick(50);
  await checkpoint();
  await assertSettled(t, h, requests, 1);
  assert.equal(contexts(h).length, 1);
});

for (const replacement of ["fork", "new", "switch"]) {
  test(`${replacement} uses only the replacement runtime's goal activation`, { timeout: 10_000 }, async (t) => {
    const h = await harness(t, { budget: 11 });
    const originalId = state(h).goalId;
    const originalSessionId = h.sessionManager.getSessionId();
    let current = h;
    const servicesFor = (fixture) => ({ cwd: fixture.sessionManager.getCwd(), agentDir: fixture.sessionManager.getCwd() });
    const runtime = new AgentSessionRuntime(h.session, servicesFor(h), async ({ sessionManager, sessionStartEvent }) => {
      current.disposed = true;
      const next = await codexHarness([piGoal], { sessionManager, sessionStartEvent });
      next.events = [];
      next.session.subscribe((event) => next.events.push(event));
      current = next;
      t.after(() => next.close());
      return { session: next.session, services: servicesFor(next), diagnostics: [] };
    });
    t.after(() => current.disposed ? undefined : runtime.dispose());
    const requests = responses(t, h, replacement === "new" ? [] : [() => textResponse()]);
    if (replacement === "fork") {
      const target = h.sessionManager.appendMessage({ role: "user", content: "Fork fixture", timestamp: Date.now() });
      await runtime.fork(target, { position: "at" });
    } else if (replacement === "new") {
      await runtime.newSession();
    } else {
      // Write a synthetic session only inside the harness's temporary directory.
      const target = SessionManager.create(h.ctx.cwd, h.ctx.cwd);
      for (const entry of h.sessionManager.getBranch()) {
        if (entry.type === "custom") target.appendCustomEntry(entry.customType, entry.data);
      }
      target.appendMessage({ role: "user", content: "Resume fixture", timestamp: Date.now() });
      target.appendMessage({
        role: "assistant", content: [{ type: "text", text: "Saved fixture response" }],
        api: h.model.api, provider: h.model.provider, model: h.model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      await runtime.switchSession(target.getSessionFile());
    }
    t.mock.timers.tick(1);
    await checkpoint();
    await assertSettled(t, current, requests, replacement === "new" ? 0 : 1);
    assert.ok(!h.events.some((event) => event.type === "entry_appended" && event.entry.customType === "pi-goal-context"), "the outgoing runtime must not receive a late goal prompt");
    assert.notEqual(current.sessionManager.getSessionId(), originalSessionId);
    if (replacement === "new") assert.equal(state(current), null);
    else {
      assert.equal(state(current).goalId, originalId);
      assert.equal(state(current).status, "budget_limited");
      assert.equal(contexts(current).length, 1);
    }
    // Dispose while the replacement's temporary storage is still available.
    await runtime.dispose();
    current.disposed = true;
  });
}

test("reload invalidates an old active timer before a paused destination is reconstructed", { timeout: 10_000 }, async (t) => {
  const h = await harness(t);
  const activeLeaf = h.sessionManager.getLeafId();
  await h.session.prompt("/goal pause");
  const pausedLeaf = h.sessionManager.getLeafId();
  await h.session.navigateTree(activeLeaf, { summarize: false });
  await h.session.navigateTree(pausedLeaf, { summarize: false });
  await h.session.reload();
  const requests = responses(t, h, []);
  await assertSettled(t, h, requests, 0);
  assert.equal(state(h).status, "paused");
  assert.equal(contexts(h).length, 0);
});

function responses(t, h, batch) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).hostname, "chatgpt.com");
    requests.push(requestBody(init));
    if (requests.length > batch.length) {
      // Bound even a broken continuation loop without live network or hangs.
      queueMicrotask(() => { void h.session.abort(); });
      return errorResponse("Unexpected fixture request");
    }
    return batch[requests.length - 1](requests.at(-1), init);
  });
  return requests;
}

async function assertSettled(t, h, requests, count) {
  await h.session.waitForIdle();
  // Deterministically fire any obsolete agent_end timer. This is supplemental
  // to the real session's request/settlement assertions, not a timed sleep.
  t.mock.timers.tick(1);
  await checkpoint();
  await h.session.waitForIdle();
  assert.equal(requests.length, count, JSON.stringify(h.events.filter((event) => ["turn_end", "compaction_start", "compaction_end"].includes(event.type))));
  assert.deepEqual(h.errors, []);
}

test("completed runs continue inside settlement, with one current context and append-only history", { timeout: 10_000 }, async (t) => {
  const previews = [];
  const observe = (pi) => pi.on("agent_before_settle", (event) => {
    previews.push({ outcome: event.outcome, canContinue: event.context.canContinue, drafts: event.entries.length, continue: event.continue });
  });
  const h = await harness(t, { budget: 33, before: [observe] });
  const requests = responses(t, h, [() => textResponse(), () => textResponse(), () => textResponse()]);
  await h.session.prompt("Run the synthetic goal.");
  await assertSettled(t, h, requests, 3);
  assert.deepEqual(previews.slice(0, 2).map((event) => event.canContinue), [false, false], "a normal reply needs a new custom-message draft");
  assert.deepEqual(requests.map(contextCount), [0, 1, 1]);
  assert.equal(contexts(h).length, 2, "pruning model context must not delete persisted history");
  assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1, "one run owns all goal continuations");
  assert.equal(state(h).status, "budget_limited");
  assert.equal(state(h).tokensUsed, 33);
});

test("model goal creation joins the running lifecycle without a separate activation timer", { timeout: 10_000 }, async (t) => {
  const h = await harness(t, { create: false });
  const requests = responses(t, h, [
    () => toolResponse("create_goal", { objective: "Synthetic model-created goal", token_budget: 22 }),
    () => textResponse("Natural tool follow-up."),
    () => textResponse("Goal continuation."),
  ]);
  await h.session.prompt("Create the synthetic goal and work on it.");
  await assertSettled(t, h, requests, 3);
  assert.equal(state(h).status, "budget_limited");
  assert.deepEqual(requests.map(contextCount), [0, 0, 1]);
  assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
});

test("cancelling Pi's retry delay leaves no goal timer behind, and explicit resume still works", { timeout: 10_000 }, async (t) => {
  const h = await harness(t, { budget: 11, retry: { enabled: true, maxRetries: 1, baseDelayMs: 50, maxDelayMs: 50 } });
  const retryStarted = Promise.withResolvers();
  h.session.subscribe((event) => { if (event.type === "auto_retry_start") retryStarted.resolve(); });
  let requests = responses(t, h, [() => errorResponse("overloaded_error")]);
  const run = h.session.prompt("Cancel a pending retry.");
  await retryStarted.promise;
  await checkpoint();
  await h.session.abort();
  await run;
  t.mock.timers.tick(100);
  await assertSettled(t, h, requests, 1);
  assert.equal(contexts(h).length, 0);
  assert.equal(state(h).status, "active");
  requests = responses(t, h, [() => textResponse()]);
  await h.session.prompt("/goal resume");
  t.mock.timers.tick(1);
  await checkpoint();
  await assertSettled(t, h, requests, 1);
  assert.equal(state(h).status, "budget_limited");
});

test("user cancellation does not restart an active goal", { timeout: 10_000 }, async (t) => {
  const h = await harness(t);
  const started = Promise.withResolvers();
  const requests = responses(t, h, [(_request, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    started.resolve();
  })]);
  const run = h.session.prompt("Cancel this fixture.");
  await started.promise;
  await h.session.abort();
  await run;
  await assertSettled(t, h, requests, 1);
  assert.equal(state(h).status, "active", "cancellation does not change persisted goal status");
  assert.equal(contexts(h).length, 0);
  assert.equal(h.events.findLast((event) => event.type === "agent_settled").aborted, true);
});

test("cancellation during a later boundary handler suppresses an already proposed continuation", { timeout: 10_000 }, async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const hold = (pi) => pi.on("agent_before_settle", async (event) => {
    assert.equal(event.continue, true);
    entered.resolve();
    await release.promise;
  });
  const h = await harness(t, { after: [hold] });
  const requests = responses(t, h, [() => textResponse()]);
  const run = h.session.prompt("Cancel at the boundary.");
  await entered.promise;
  const abort = h.session.abort();
  release.resolve();
  await Promise.all([run, abort]);
  await assertSettled(t, h, requests, 1);
  assert.equal(h.events.findLast((event) => event.type === "agent_settled").aborted, true);
});

test("a terminal provider error does not synthesize another failing turn", { timeout: 10_000 }, async (t) => {
  const h = await harness(t);
  const requests = responses(t, h, [() => errorResponse("Invalid API key for fixture")]);
  await h.session.prompt("Exercise a terminal error.");
  await assertSettled(t, h, requests, 1);
  assert.equal(contexts(h).length, 0);
  assert.equal(state(h).status, "active");
  assert.equal(h.session.messages.findLast((message) => message.role === "assistant").stopReason, "error");
});

test("usage-limit notices are persisted without a wrap-up request", { timeout: 10_000 }, async (t) => {
  const h = await harness(t);
  const requests = responses(t, h, [() => errorResponse("5-hour usage limit reached")]);
  await h.session.prompt("Exercise a provider limit.");
  await assertSettled(t, h, requests, 1);
  assert.equal(state(h).status, "usage_limited");
  assert.ok(h.session.messages.some((message) => message.role === "custom" && message.details?.kind === "provider_limit"));
  assert.equal(contexts(h).length, 0);
});

for (const exhausted of [false, true]) {
  test(`Pi owns retry scheduling before goal continuation (exhausted=${exhausted})`, { timeout: 10_000 }, async (t) => {
    const boundaryOutcomes = [];
    const observe = (pi) => pi.on("agent_before_settle", (event) => { boundaryOutcomes.push(event.outcome); });
    const h = await harness(t, {
      before: [observe],
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const retryStarted = Promise.withResolvers();
    h.session.subscribe((event) => { if (event.type === "auto_retry_start") retryStarted.resolve(); });
    const requests = responses(t, h, [
      () => errorResponse("overloaded_error"),
      () => exhausted ? errorResponse("overloaded_error") : textResponse("Recovered."),
      ...exhausted ? [] : [() => textResponse("Goal continuation.")],
    ]);
    const run = h.session.prompt("Exercise retry policy.");
    await retryStarted.promise;
    await checkpoint();
    assert.equal(requests.length, 1);
    assert.equal(contexts(h).length, 0, "no goal message may race the retry delay");
    t.mock.timers.tick(2);
    await run;
    await assertSettled(t, h, requests, exhausted ? 2 : 3);
    assert.deepEqual(boundaryOutcomes, exhausted ? ["error"] : ["completed", "completed"]);
    const edits = h.sessionManager.getBranch().filter((entry) => entry.type === "context_edit");
    assert.equal(edits.length, 1, "retry repair remains in append-only history");
    assert.deepEqual(requests.map(contextCount), exhausted ? [0, 0] : [0, 0, 1]);
  });
}

for (const delivery of ["steer", "followUp"]) {
  test(`${delivery} work has priority, including messages queued during boundary dispatch`, { timeout: 10_000 }, async (t) => {
    let queued = false;
    const queue = (pi) => pi.on("agent_before_settle", () => {
      if (queued) return;
      queued = true;
      pi.sendUserMessage("Priority fixture work", { deliverAs: delivery });
    });
    const h = await harness(t, { budget: 33, before: [queue] });
    const requests = responses(t, h, [() => textResponse(), () => textResponse(), () => textResponse()]);
    await h.session.prompt("Run queued work first.");
    await assertSettled(t, h, requests, 3);
    assert.deepEqual(requests.map(contextCount), [0, 0, 1]);
    assert.equal(requests[1].input.filter((item) => JSON.stringify(item).includes("Priority fixture work")).length, 1);
    assert.equal(h.session.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("Priority fixture work")).length, 1);
  });
}

for (const first of [true, false]) {
  test(`boundary proposals compose in either handler order (goal first=${first})`, { timeout: 10_000 }, async (t) => {
    let proposed = false;
    const companion = (pi) => pi.on("agent_before_settle", (event) => {
      if (proposed) return;
      proposed = true;
      return { entries: [...event.entries, { type: "custom_message", customType: "fixture-companion", content: "Companion entry", display: false }], continue: true };
    });
    const h = await harness(t, first ? { after: [companion] } : { before: [companion] });
    const requests = responses(t, h, [() => textResponse(), () => textResponse()]);
    await h.session.prompt("Compose continuation proposals.");
    await assertSettled(t, h, requests, 2);
    assert.equal(contextCount(requests[1]), 1);
    assert.equal(requests[1].input.filter((item) => JSON.stringify(item).includes("Companion entry")).length, 1);
    assert.equal(contexts(h).length, 1);
  });
}

test("Pi rejects a proposal made unrunnable by a later handler instead of restarting out of band", { timeout: 10_000 }, async (t) => {
  const veto = (pi) => pi.on("agent_before_settle", (event) => ({ entries: event.entries.filter((entry) => entry.customType !== "pi-goal-context") }));
  const h = await harness(t, { after: [veto] });
  const requests = responses(t, h, [() => textResponse()]);
  await h.session.prompt("Remove the continuation input.");
  t.mock.timers.tick(1);
  await checkpoint();
  assert.equal(requests.length, 1);
  assert.equal(contexts(h).length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].error, /without runnable model context/);
});

for (const status of ["complete", "blocked"]) {
  test(`a direct ${status} tool call stops goal continuation`, { timeout: 10_000 }, async (t) => {
    const h = await harness(t, { budget: 100 });
    // The existing visible terminal goal event uses Pi's steering queue. Preserve
    // that notification's response, but never append another goal-context draft.
    const requests = responses(t, h, [() => textResponse(), () => terminalResponse(status), () => textResponse()]);
    await h.session.prompt("Complete the synthetic goal.");
    await assertSettled(t, h, requests, 3);
    assert.equal(state(h).status, status);
    assert.deepEqual(requests.map(contextCount), [0, 1, 0]);
    assert.equal(contexts(h).length, 1);
  });
}
