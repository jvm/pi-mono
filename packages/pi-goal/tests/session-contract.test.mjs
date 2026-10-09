import assert from "node:assert/strict";
import test from "node:test";
import { createCodemodeExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codexHarness, requestBody, textResponse } from "../../../tests/codex-harness.mjs";
import { registerGoalTools } from "../src/tools.ts";
import { applyGoalMutation, createGoalMutation, reconstructGoalState, statusMutation } from "../src/state.ts";
import { GOAL_ENTRY_TYPE } from "../src/types.ts";
import { accountUsageFromBranch } from "../src/accounting.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const { default: piGoal } = await import("../extensions/index.ts");
const statuses = ["complete", "blocked"];
let callSequence = 0;

function functionCall(name, args) {
  const id = `${name}_${++callSequence}`;
  return { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) };
}

function scriptCall(code) {
  const id = `code_${++callSequence}`;
  return { type: "custom_tool_call", id: `ct_${id}`, call_id: `call_${id}`, name: "codemode", input: code };
}

function codemodeCall(request, code) {
  const declaration = request.tools.find((tool) => tool.name === "codemode");
  assert.ok(declaration, "codemode must be declared");
  return declaration.type === "custom" ? scriptCall(code) : functionCall("codemode", { code });
}

// Exercise the provider serializer and parser, not a hand-written assistant message.
function toolResponse(items) {
  const events = items.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item: {
      ...item, ...(item.type === "function_call" ? { arguments: "" } : { input: "" }),
    } },
    item.type === "function_call"
      ? { type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta: item.arguments }
      : { type: "response.custom_tool_call_input.delta", output_index, item_id: item.id, delta: item.input },
    { type: "response.output_item.done", output_index, item },
  ]);
  events.push({ type: "response.completed", response: {
    status: "completed", output: items, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
  } });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function goalHarness(t, { mode = "off", toolsOnly = false, extra = [], tokenBudget } = {}) {
  // Block network before loading anything. Test credentials come only from the
  // shared harness's in-memory fixture store, never from the user's Pi settings.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network request blocked"); });
  const sessionManager = SessionManager.inMemory();
  const create = createGoalMutation("Synthetic completion-boundary fixture", tokenBudget);
  sessionManager.appendCustomEntry(GOAL_ENTRY_TYPE, create);
  const initial = applyGoalMutation(null, create);
  if (!toolsOnly) {
    // Keep production lifecycle fixtures paused so the existing continuation
    // scheduler cannot start an unrelated turn on startup or after a denial.
    sessionManager.appendCustomEntry(GOAL_ENTRY_TYPE, statusMutation(initial, "paused", 0));
  }
  const core = (pi) => {
    let goal = reconstructGoalState(sessionManager.getBranch());
    registerGoalTools(pi, {
      getGoal: () => goal,
      setGoal: (next) => { goal = next; },
      afterGoalChanged() {},
      clearContinuation() {},
    });
  };
  const h = await codexHarness([
    ...(mode === "off" ? [] : [createCodemodeExtension({ mode })]),
    toolsOnly ? core : piGoal,
    ...extra,
  ], { sessionManager, defaultTools: mode === "off" ? undefined : ["codemode"] });
  t.after(async () => { await h.close(); });
  return h;
}

const meteredUsage = (tokens) => ({
  input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

for (const outcome of ["success", "error", "cancelled"]) {
  test(`codemode aggregates multi-level ${outcome} usage and goal accounts all 522 tokens once`, async (t) => {
    const metered = (pi) => {
      pi.registerTool({
        name: "fixture_metered", label: "Metered", description: "Synthetic metered call.",
        parameters: Type.Object({}),
        async execute() {
          return {
            content: [{ type: "text", text: outcome }], details: undefined,
            usage: meteredUsage(500), ...(outcome === "success" ? {} : { isError: true }),
          };
        },
      });
      pi.registerTool({
        name: "fixture_wrapper", label: "Wrapper", description: "Another nesting level.",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          await ctx.executeTool("fixture_metered", {});
          // The wrapper reports no nested usage itself.
          return { content: [{ type: "text", text: "wrapped" }], details: undefined };
        },
      });
    };
    const h = await goalHarness(t, { mode: "only", extra: [metered] });
    mockResponses(t, [
      () => toolResponse([scriptCall('text(await tools.fixture_wrapper({}));')]),
      () => textResponse(),
    ]);
    await h.session.prompt("Exercise nested mock metering.");
    assert.equal(resultFor(h, "codemode").usage.totalTokens, 500);
    assert.equal(goalState(h).tokensUsed, 522);
    assert.equal(accountUsageFromBranch(goalState(h), h.sessionManager.getBranch()).addedTokens, 0);
    await h.session.reload();
    assert.equal(goalState(h).tokensUsed, 522);
    assert.deepEqual(h.errors, []);
  });
}

test("tool-only overspend is persisted before settlement without a notification or continuation request", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network request blocked"); });
  let settledState;
  const metered = (pi) => {
    pi.registerTool({
      name: "fixture_metered", label: "Metered", description: "Synthetic terminating call.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "done" }], details: undefined, usage: meteredUsage(500), terminate: true };
      },
    });
    pi.on("agent_before_settle", (_event, ctx) => {
      settledState = reconstructGoalState(ctx.sessionManager.getBranch());
    });
  };
  const h = await codexHarness([piGoal, metered]);
  t.after(async () => { await h.close(); });
  const requests = mockResponses(t, [
    () => toolResponse([functionCall("create_goal", { objective: "Budget fixture", token_budget: 100 })]),
    () => toolResponse([functionCall("fixture_metered", {})]),
  ]);
  await h.session.prompt("Create then exercise a budgeted goal.");
  assert.equal(goalState(h).tokensUsed, 511, "the creation assistant precedes the accounting interval");
  assert.equal(goalState(h).status, "budget_limited");
  assert.equal(settledState.status, "budget_limited");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 2);
  assert.deepEqual(h.errors, []);
});

test("idle standalone usage is observed without an assistant turn and survives context omission", async (t) => {
  const h = await goalHarness(t, { tokenBudget: 100 });
  const entry = h.sessionManager.appendUsage("cache_warm", "fixture", "fixture", meteredUsage(500));
  // Idle warming has no extension entry_appended hook in Pi 1.1.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(goalState(h).tokensUsed, 500);
  assert.equal(goalState(h).status, "paused");
  assert.ok(goalState(h).accountedUsage.entryIds.includes(entry.id));
  await h.session.reload();
  assert.equal(goalState(h).tokensUsed, 500);
  assert.deepEqual(h.errors, []);
});

test("context-omitted billed attempts and forked histories retain branch-local totals", async (t) => {
  const h = await goalHarness(t);
  mockResponses(t, [() => textResponse(), () => textResponse()]);
  await h.session.prompt("Billed fixture attempt.");
  const billed = h.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  h.sessionManager.appendContextEdit(billed.id, null);
  h.sessionManager.appendUsage("fixture", "fixture", "fixture", meteredUsage(500));
  await h.session.reload();
  assert.equal(goalState(h).tokensUsed, 511);
  assert.ok(!h.sessionManager.buildSessionProjection().entries.some((entry) => entry.sourceEntry.id === billed.id && entry.messages.length));
  const fork = SessionManager.inMemory("/tmp", { id: "accounting-fork-fixture" }, structuredClone(h.sessionManager.getBranch()));
  const forked = await codexHarness([piGoal], { sessionManager: fork });
  t.after(async () => { await forked.close(); });
  fork.appendUsage("fixture", "fixture", "fixture", meteredUsage(30));
  await forked.session.reload();
  assert.equal(goalState(forked).tokensUsed, 541);
  assert.equal(goalState(h).tokensUsed, 511);
  await h.session.prompt("Original branch fixture.");
  assert.equal(goalState(h).tokensUsed, 522);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(forked.errors, []);
});

test("compaction and tree-summary usage are charged at lifecycle boundaries", async (t) => {
  const summarize = (pi) => {
    pi.on("session_before_compact", (event) => ({
      compaction: {
        summary: "Synthetic summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, usage: meteredUsage(100),
      },
    }));
    pi.on("session_before_tree", () => ({ summary: { summary: "Synthetic branch summary", usage: meteredUsage(200) } }));
  };
  const h = await goalHarness(t, { extra: [summarize] });
  mockResponses(t, [() => textResponse(), () => textResponse()]);
  await h.session.prompt("First fixture message.");
  const target = h.sessionManager.getLeafId();
  await h.session.prompt("Second fixture message.");
  await h.session.compact();
  assert.equal(goalState(h).tokensUsed, 122);
  const billed = h.sessionManager.getBranch().find((entry) => entry.type === "compaction");
  assert.equal(billed.usage.totalTokens, 100);
  await h.session.navigateTree(target, { summarize: true });
  const summary = h.sessionManager.getBranch().findLast((entry) => entry.type === "branch_summary");
  assert.equal(summary.usage.totalTokens, 200);
  assert.equal(goalState(h).tokensUsed, 211, "abandoned branch work is not imported with its summary");
  assert.deepEqual(h.errors, []);
});

async function waitFor(predicate, diagnostic = () => "") {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `mocked warming/accounting did not finish: ${diagnostic()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function enableFastFixtureWarming(h) {
  h.session.settingsManager.setCacheWarmingMode("idle");
  await h.session.setModel({
    ...h.model, promptCache: { short: 11, long: 11 },
    cost: { input: 1_000_000, output: 1, cacheRead: 1, cacheWrite: 0 },
  });
}

for (const reverse of [false, true]) {
  test(`mocked idle warming counts usage without changing compaction/reasoning state (reverse=${reverse})`, async (t) => {
    const { default: reasoning } = await import("../../pi-openai-reasoning/extensions/index.ts");
    const { default: compaction } = await import("../../pi-codex-compaction/extensions/index.ts");
    const { STATE_TYPE } = await import("../../pi-openai-reasoning/src/reasoning.ts");
    const h = await goalHarness(t, { extra: reverse ? [compaction, reasoning] : [reasoning, compaction] });
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      const body = requestBody(init);
      requests.push(body);
      return textResponse();
    });
    await h.session.prompt("Old fixture context.");
    h.session.setThinkingLevel("high");
    await h.session.prompt("Kept fixture context.");
    assert.equal(goalState(h).tokensUsed, 22);
    await enableFastFixtureWarming(h);
    await h.session.prompt("Warm fixture with cooperating hooks loaded.");
    const lastRequest = requests.at(-1);
    const before = structuredClone(h.sessionManager.getBranch().filter((entry) => entry.customType === STATE_TYPE));
    const tokensBefore = goalState(h).tokensUsed;
    h.session.setThinkingLevel("low");
    await waitFor(() => h.sessionManager.getBranch().some((entry) => entry.type === "usage" && entry.kind === "cache_warm"),
      () => JSON.stringify({ status: h.session.cacheWarmingStatus, requests: requests.length, errors: h.errors }));
    h.session.settingsManager.setCacheWarmingMode("off");
    await waitFor(() => goalState(h).tokensUsed === tokensBefore + 11);
    assert.deepEqual(requests.at(-1).input, lastRequest.input);
    assert.deepEqual(requests.at(-1).reasoning, lastRequest.reasoning);
    assert.deepEqual(h.sessionManager.getBranch().filter((entry) => entry.customType === STATE_TYPE), before);
    const compacted = await h.session.compact();
    assert.notEqual(compacted.details?.kind, "pi-codex-compaction");
    assert.equal(requests.some((r) => r.input.some((item) => item.type === "compaction_trigger")), false);
    assert.equal(goalState(h).tokensUsed, tokensBefore + 11 + compacted.usage.totalTokens);
    assert.deepEqual(h.sessionManager.getBranch().filter((entry) => entry.customType === STATE_TYPE), before);
    assert.deepEqual(h.errors, []);
  });
}

test("real warming decision chain stops budgeted goals and permits an explicit later override", async (t) => {
  let decisions = 0;
  let override = false;
  const other = (pi) => pi.on("cache_warming_decision", () => {
    decisions++;
    return override ? { action: "warm" } : undefined;
  });
  const h = await goalHarness(t, { tokenBudget: 100, extra: [other] });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return textResponse(); });
  await enableFastFixtureWarming(h);
  await h.session.prompt("Budgeted fixture.");
  await waitFor(() => decisions === 1);
  assert.equal(requests, 1, "pi-goal stopped the idle refresh");
  override = true;
  await h.session.prompt("Explicit override fixture.");
  await waitFor(() => h.sessionManager.getBranch().some((entry) => entry.type === "usage"));
  h.session.settingsManager.setCacheWarmingMode("off");
  await waitFor(() => goalState(h).tokensUsed === 33);
  assert.equal(requests, 3);
  assert.deepEqual(h.errors, []);
});

function mockResponses(t, responses) {
  const requests = [];
  t.after(() => { assert.equal(requests.length, responses.length, "provider request count must match the batch/queue contract"); });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).hostname, "chatgpt.com");
    requests.push(requestBody(init));
    assert.ok(requests.length <= responses.length, "unexpected extra provider request");
    return responses[requests.length - 1](requests[requests.length - 1]);
  });
  return requests;
}

function goalState(h) {
  return reconstructGoalState(h.sessionManager.getBranch());
}

function goalMutations(h) {
  return h.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY_TYPE)
    .map((entry) => entry.data);
}

function resultFor(h, name) {
  const result = h.session.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
  assert.ok(result, `${name} must have a transcript result`);
  return result;
}

function textOf(result) {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function assertExposure(h, request) {
  assert.equal(h.session.getToolDefinition("update_goal").exposure, "model-only");
  assert.ok(h.session.getActiveToolNames().includes("update_goal"));
  assert.ok(!h.session.getCallableToolNames().includes("update_goal"));
  for (const name of ["get_goal", "create_goal"]) {
    assert.equal(h.session.getToolDefinition(name).exposure ?? "direct", "direct");
    assert.ok(h.session.getCallableToolNames().includes(name));
  }
  const declaration = request.tools.find((tool) => tool.name === "update_goal");
  assert.ok(declaration, "terminal update must remain declared, including in codemode-only mode");
  assert.match(declaration.description, /separate final assistant turn/);
  const codemode = request.tools.find((tool) => tool.name === "codemode");
  if (codemode) {
    assert.ok(!/tools\.update_goal|declare function update_goal/.test(codemode.description));
  }
}

for (const mode of ["off", "on", "only"]) {
  for (const status of statuses) {
    test(`production direct ${status} remains available with codemode ${mode}`, async (t) => {
      const h = await goalHarness(t, { mode });
      const verification = { summary: "Inspected fixture evidence", checked_requirements: ["fixture"], commands: ["mock verification"] };
      const requests = mockResponses(t, [
        () => toolResponse([functionCall("update_goal", { status, verification })]),
        () => textResponse(),
      ]);
      await h.session.prompt("Finalize the synthetic fixture directly.");
      assertExposure(h, requests[0]);
      const result = resultFor(h, "update_goal");
      assert.equal(result.isError, false);
      assert.equal(goalState(h).status, status);
      const mutation = goalMutations(h).findLast((entry) => entry.kind === "status");
      assert.equal(mutation.meta.trigger.toolCallId, result.toolCallId);
      assert.ok(mutation.meta.trigger.messageId, "direct call context must be present in a real session");
      assert.deepEqual(mutation.meta.trigger.siblingToolCalls, [{ id: result.toolCallId, name: "update_goal" }]);
      assert.equal(mutation.meta.verification.summary, verification.summary);
      // Production sends a visible goal event through Pi's existing steering
      // queue. terminate must not discard that queued notification turn.
      assert.equal(requests.length, 2);
      assert.deepEqual(h.errors, []);
    });
  }

  test(`ctx.executeTool rejects both terminal statuses with codemode ${mode}`, async (t) => {
    let attempts = 0;
    const probe = (pi) => pi.registerTool({
      name: "nested_probe", label: "Probe", description: "Exercise fixture nested calls.",
      parameters: Type.Object({}),
      exposure: "model-only",
      async execute(_id, _args, _signal, _onUpdate, ctx) {
        assert.ok(!ctx.tools.some((tool) => tool.name === "update_goal"));
        const before = await ctx.executeTool("get_goal", {});
        assert.equal(before.isError, false);
        for (const status of statuses) {
          const entryCount = ctx.sessionManager.getEntryCount();
          const outcome = await ctx.executeTool("update_goal", { status });
          attempts++;
          assert.equal(outcome.isError, true);
          assert.equal(ctx.sessionManager.getEntryCount(), entryCount, "denied nested call must not append mutations");
          const after = await ctx.executeTool("get_goal", {});
          assert.deepEqual(after.result, before.result);
        }
        return { content: [{ type: "text", text: "Nested terminal updates denied" }], details: undefined };
      },
    });
    const h = await goalHarness(t, { mode, extra: [probe] });
    const requests = mockResponses(t, [
      () => toolResponse([functionCall("nested_probe", {})]),
      () => textResponse(),
    ]);
    // The model-only fixture probe stays declared even in codemode-only mode.
    await h.session.prompt("Exercise nested dispatch without changing the fixture.");
    assert.equal(resultFor(h, "nested_probe").isError, false);
    assert.equal(attempts, 2);
    assert.equal(goalState(h).status, "paused");
    assertExposure(h, requests[0]);
    assert.deepEqual(h.errors, []);
  });
}

for (const mode of ["on", "only"]) {
  test(`codemode ${mode} cannot discover or invoke terminal updates`, async (t) => {
    const h = await goalHarness(t, { mode });
    const code = [
      'text({ names: ALL_TOOLS.map(tool => tool.name), found: await searchTools("update_goal"), description: (await describeTool("update_goal")) ?? null, callable: "update_goal" in tools });',
      'text(await tools.get_goal({}));',
      'for (const status of ["complete", "blocked"]) { try { await tools.update_goal({ status }); text("UNEXPECTED SUCCESS"); } catch (error) { text("Denied " + status); } }',
      'text(await tools.get_goal({}));',
    ].join("\n");
    const requests = mockResponses(t, [() => toolResponse([scriptCall(code)]), () => textResponse()]);
    await h.session.prompt("Check discovery and denied completion in a fixture script.");
    assertExposure(h, requests[0]);
    const result = resultFor(h, "codemode");
    assert.equal(result.isError, false, textOf(result));
    const output = textOf(result);
    assert.match(output, /"description":null/);
    assert.match(output, /"callable":false/);
    assert.ok(!output.includes('"name":"update_goal"'));
    assert.ok(!output.includes('"update_goal"'), "ALL_TOOLS must not contain the terminal tool");
    assert.match(output, /Denied complete/);
    assert.match(output, /Denied blocked/);
    assert.ok(!output.includes("UNEXPECTED SUCCESS"));
    assert.deepEqual(result.nestedCalls.calls.map((call) => call.name), ["get_goal", "get_goal"]);
    assert.equal(goalState(h).status, "paused");
    assert.ok(!goalMutations(h).some((mutation) => statuses.includes(mutation.status)));
    assert.deepEqual(h.errors, []);
  });
}

for (const status of statuses) {
  test(`active goal cannot become ${status} from nested dispatch`, async (t) => {
    let statusSeenByVerification;
    const verify = (pi) => pi.registerTool({
      name: "fixture_verify", label: "Verify", description: "Inspect active fixture state.",
      parameters: Type.Object({}),
      async execute(_id, _args, _signal, _onUpdate, ctx) {
        statusSeenByVerification = reconstructGoalState(ctx.sessionManager.getBranch()).status;
        return { content: [{ type: "text", text: "Fixture verification failed" }], details: undefined };
      },
    });
    const h = await goalHarness(t, { mode: "only", toolsOnly: true, extra: [verify] });
    const before = goalState(h);
    const code = `try { await tools.update_goal({status: "${status}"}); } catch (error) { text(error.message); } text(await tools.fixture_verify({}));`;
    mockResponses(t, [() => toolResponse([scriptCall(code)]), () => textResponse()]);
    await h.session.prompt("Reproduce the former active-goal nested bypass.");
    assert.equal(resultFor(h, "codemode").isError, false);
    assert.equal(statusSeenByVerification, "active", "verification must not run after a terminal mutation");
    assert.deepEqual(goalState(h), before);
    assert.deepEqual(resultFor(h, "codemode").nestedCalls.calls.map((call) => call.name), ["fixture_verify"]);
    assert.deepEqual(h.errors, []);
  });

  test(`direct ${status} rejects a mixed verification batch`, async (t) => {
    let verified = false;
    const verify = (pi) => pi.registerTool({
      name: "fixture_verify", label: "Verify", description: "Mock fixture verification.",
      parameters: Type.Object({}),
      async execute() {
        verified = true;
        return { content: [{ type: "text", text: "Fixture checked" }], details: undefined };
      },
    });
    const h = await goalHarness(t, { extra: [verify] });
    mockResponses(t, [
      () => toolResponse([functionCall("fixture_verify", {}), functionCall("update_goal", { status })]),
      () => textResponse(),
    ]);
    await h.session.prompt("Attempt a forbidden combined verification and update.");
    assert.equal(verified, true);
    const result = resultFor(h, "update_goal");
    assert.equal(result.isError, true);
    assert.match(textOf(result), /only tool call/);
    assert.equal(goalState(h).status, "paused");
    assert.ok(!goalMutations(h).some((mutation) => statuses.includes(mutation.status)));
    assert.deepEqual(h.errors, []);
  });

  test(`standalone direct ${status} terminates without queued work`, async (t) => {
    const h = await goalHarness(t, { toolsOnly: true });
    const requests = mockResponses(t, [() => toolResponse([functionCall("update_goal", { status })])]);
    await h.session.prompt("Finalize the active fixture with no queued notifications.");
    assert.equal(resultFor(h, "update_goal").isError, false);
    assert.equal(goalState(h).status, status);
    assert.equal(requests.length, 1, "terminate must skip the automatic follow-up");
    assert.deepEqual(h.errors, []);
  });

  test(`verification results precede a separate direct ${status} turn`, async (t) => {
    const verify = (pi) => pi.registerTool({
      name: "fixture_verify", label: "Verify", description: "Mock fixture verification.",
      parameters: Type.Object({}),
      async execute(_id, _args, _signal, _onUpdate, ctx) {
        assert.equal(reconstructGoalState(ctx.sessionManager.getBranch()).status, "active");
        return { content: [{ type: "text", text: "Already-inspected fixture evidence" }], details: undefined };
      },
    });
    const h = await goalHarness(t, { toolsOnly: true, extra: [verify] });
    const requests = mockResponses(t, [
      () => toolResponse([functionCall("fixture_verify", {})]),
      () => toolResponse([functionCall("update_goal", { status, verification: { summary: "Already-inspected fixture evidence" } })]),
    ]);
    await h.session.prompt("Verify first, then finalize in a separate assistant turn.");
    assert.ok(JSON.stringify(requests[1].input).includes("Already-inspected fixture evidence"));
    assert.equal(resultFor(h, "update_goal").isError, false);
    assert.equal(goalState(h).status, status);
    assert.equal(requests.length, 2, "the final update must not add a third request");
    assert.deepEqual(h.errors, []);
  });

  test(`reload, model selection, and branch reconstruction preserve ${status} boundaries`, async (t) => {
    const h = await goalHarness(t, { mode: "only" });
    const pausedLeaf = h.sessionManager.getLeafId();
    const originalGoalId = goalState(h).goalId;
    let requests = mockResponses(t, [
      () => toolResponse([functionCall("update_goal", { status })]),
      () => textResponse(),
    ]);
    await h.session.prompt("Finalize the original fixture branch.");
    assertExposure(h, requests[0]);
    assert.equal(goalState(h).status, status);
    const terminalLeaf = h.sessionManager.getLeafId();
    await h.session.reload();
    for (const model of [
      { ...h.model, id: "fixture-model-change", compat: { ...h.model.compat, supportsOpenAIGrammarTools: false } },
      h.model,
    ]) {
      await h.session.setModel(model);
      requests = mockResponses(t, [
        (request) => toolResponse([codemodeCall(request, 'const {goal} = await tools.get_goal({}); text({status: goal.status, goalId: goal.goalId});')]),
        () => textResponse(),
      ]);
      await h.session.prompt("Inspect the reconstructed terminal branch.");
      assertExposure(h, requests[0]);
      assert.equal(resultFor(h, "codemode").isError, false, textOf(resultFor(h, "codemode")));
      assert.ok(textOf(resultFor(h, "codemode")).includes(`"status":"${status}"`));
      assert.ok(textOf(resultFor(h, "codemode")).includes(`"goalId":"${originalGoalId}"`));
      assert.equal(goalState(h).goalId, originalGoalId);
    }
    assert.equal((await h.session.navigateTree(pausedLeaf, { summarize: false })).cancelled, false);
    await h.session.reload();
    requests = mockResponses(t, [
      (request) => toolResponse([codemodeCall(request, 'const {goal} = await tools.get_goal({}); text({status: goal.status});')]),
      () => textResponse(),
    ]);
    await h.session.prompt("Inspect the independent pre-completion branch.");
    assertExposure(h, requests[0]);
    assert.equal(resultFor(h, "codemode").isError, false, textOf(resultFor(h, "codemode")));
    assert.ok(textOf(resultFor(h, "codemode")).includes('"status":"paused"'));
    assert.equal((await h.session.navigateTree(terminalLeaf, { summarize: false })).cancelled, false);
    await h.session.reload();
    requests = mockResponses(t, [
      (request) => toolResponse([codemodeCall(request, 'text(await describeTool("update_goal")); try { await tools.update_goal({status: "complete"}); } catch (error) { text("Denied"); } text(await tools.get_goal({}));')]),
      () => textResponse(),
    ]);
    await h.session.prompt("Check restored terminal branch discovery and nested denial.");
    assertExposure(h, requests[0]);
    assert.equal(resultFor(h, "codemode").isError, false);
    assert.match(textOf(resultFor(h, "codemode")), /Denied/);
    assert.equal(goalState(h).status, status);
    assert.equal(goalState(h).goalId, originalGoalId);
    assert.deepEqual(h.errors, []);
  });
}
