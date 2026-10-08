import assert from "node:assert/strict";
import test from "node:test";
import { createCodemodeExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codexHarness, requestBody, textResponse } from "../../../tests/codex-harness.mjs";
import { registerGoalTools } from "../src/tools.ts";
import { applyGoalMutation, createGoalMutation, reconstructGoalState, statusMutation } from "../src/state.ts";
import { GOAL_ENTRY_TYPE } from "../src/types.ts";

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

async function goalHarness(t, { mode = "off", toolsOnly = false, extra = [] } = {}) {
  // Block network before loading anything. Test credentials come only from the
  // shared harness's in-memory fixture store, never from the user's Pi settings.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network request blocked"); });
  const sessionManager = SessionManager.inMemory();
  const create = createGoalMutation("Synthetic completion-boundary fixture");
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
    assert.equal(goalState(h).status, status);
    const terminalLeaf = h.sessionManager.getLeafId();
    await h.session.reload();
    for (const model of [
      { ...h.model, id: "fixture-model-change", compat: { ...h.model.compat, supportsOpenAIGrammarTools: false } },
      h.model,
    ]) {
      await h.session.setModel(model);
      requests = mockResponses(t, [
        (request) => toolResponse([codemodeCall(request, 'const {goal} = JSON.parse(await tools.get_goal({})); text({status: goal.status, goalId: goal.goalId});')]),
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
      (request) => toolResponse([codemodeCall(request, 'const {goal} = JSON.parse(await tools.get_goal({})); text({status: goal.status});')]),
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
