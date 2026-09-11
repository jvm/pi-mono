import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { codexHarness, compactionResponse, requestBody, textResponse } from "../../../tests/codex-harness.mjs";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";
const { default: reasoning } = await import("../extensions/index.ts");
const { STATE_TYPE, rewriteReasoning, supportsReasoningUpdates } = await import("../src/reasoning.ts");
const { default: compaction } = await import("../../pi-codex-compaction/extensions/index.ts");
const { default: fast } = await import("../../pi-fast/extensions/index.ts");
const { default: tools } = await import("../../pi-codex-tools/extensions/index.ts");
const model = {
  id: "gpt-6-astra", provider: "openai-codex", api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true,
};
const user = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const body = (input, effort = "low") => ({
  model: model.id, input, reasoning: { effort, summary: "auto" }, tools: [],
  service_tier: "priority", prompt_cache_key: "fixture", stream: true, store: false,
});
const stateEntry = (state) => ({ type: "custom", customType: STATE_TYPE, data: state });
const updates = (payload) => payload.input.filter((item) => item.type === "configuration_update");

test("real Pi thinking controls pin effort and replay changes in a standalone install", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(requestBody(init));
    return textResponse();
  });
  const h = await codexHarness([reasoning]);
  try {
    for (const level of ["low", "high", "max", "medium", "xhigh", "low"]) {
      h.session.setThinkingLevel(level);
      await h.session.prompt(`Reply OK at ${level}.`);
      assert.equal(h.session.messages.at(-1).stopReason, "stop");
      assert.equal(requests.at(-1).reasoning.effort, "low");
      assert.equal(updates(requests.at(-1)).at(-1)?.reasoning.effort ?? "low", level);
      assert.equal(h.session.thinkingLevel, level);
    }
    for (let n = 1; n < requests.length; n++) {
      assert.deepEqual(
        requests[n].input.slice(0, requests[n - 1].input.length),
        requests[n - 1].input,
        "a later request must not move existing updates or history",
      );
      assert.equal(requests[n].input.at(-2).type, "configuration_update");
    }
    const state = h.sessionManager.getBranch().filter((entry) => entry.customType === STATE_TYPE);
    assert.equal(state.length, 6);
    assert.equal(JSON.stringify(state).includes("Reply OK"), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("identical retries and repeated toggles do not duplicate or move updates", () => {
  const first = rewriteReasoning(body([user("first")]), model, []);
  const input = [user("first"), assistant("answer"), user("second")];
  const changed = rewriteReasoning(body(input, "high"), model, [stateEntry(first.state)]);
  const retry = rewriteReasoning(body(input, "max"), model, [stateEntry(changed.state)]);
  assert.deepEqual(retry.payload, changed.payload);
  assert.equal(retry.state, undefined);
  assert.equal(rewriteReasoning(changed.payload, model, [stateEntry(changed.state)]), undefined);
  const next = rewriteReasoning(body([...input, assistant("answer"), user("third")], "max"), model, [stateEntry(changed.state)]);
  assert.deepEqual(updates(next.payload).map((u) => u.reasoning.effort), ["high", "max"]);
});

test("tool-only continuations and retry recovery never produce adjacent updates", () => {
  let input = [user("first")];
  let result = rewriteReasoning(body(input), model, []);
  input = [...input, { type: "function_call", name: "fixture", call_id: "c", arguments: "{}" },
    { type: "function_call_output", call_id: "c", output: "ok" }];
  result = rewriteReasoning(body(input, "high"), model, [stateEntry(result.state)]);
  assert.equal(result.payload.input.at(-1).type, "configuration_update");
  input = [...input, user("recovery")];
  result = rewriteReasoning(body(input, "max"), model, [stateEntry(result.state)]);
  assert.equal(updates(result.payload).at(-1).reasoning.effort, "max");
  for (let i = 1; i < result.payload.input.length; i++) {
    assert.ok(!(result.payload.input[i].type === "configuration_update" &&
      result.payload.input[i - 1].type === "configuration_update"));
  }
});

test("resume, fork and branch traversal use only surviving Pi entries", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(requestBody(init)); return textResponse();
  });
  const h = await codexHarness([reasoning]);
  let entries;
  try {
    await h.session.prompt("first");
    const forkPoint = h.sessionManager.getLeafId();
    h.session.setThinkingLevel("high");
    await h.session.prompt("second");
    entries = structuredClone(h.sessionManager.getBranch());
    h.sessionManager.branch(forkPoint);
    h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
    h.session.setThinkingLevel("medium");
    await h.session.prompt("branch");
    assert.deepEqual(updates(requests.at(-1)).map((u) => u.reasoning.effort), ["medium"]);
    assert.equal(requests.at(-1).reasoning.effort, "low");
  } finally { await h.close(); }
  // Same Pi session format used by resume/import/fork. No runtime state is shared.
  const restored = SessionManager.inMemory("/tmp", { id: "restored-fixture" }, entries);
  const resumed = await codexHarness([reasoning], { sessionManager: restored });
  try {
    resumed.session.setThinkingLevel("max");
    await resumed.session.prompt("resumed");
    assert.equal(requests.at(-1).reasoning.effort, "low");
    assert.deepEqual(updates(requests.at(-1)).map((u) => u.reasoning.effort), ["high", "max"]);
    assert.deepEqual(resumed.errors, []);
  } finally { await resumed.close(); }
});

for (const factories of [[reasoning, compaction, fast, tools], [tools, fast, compaction, reasoning]]) {
  test(`compaction uses current effort without mutating the pin (${factories[0].name} first)`, async (t) => {
    const requests = [];
    let failCompaction = true;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      const next = requestBody(init); requests.push(next);
      return next.input.some((item) => item.type === "compaction_trigger")
        ? failCompaction ? new Response("", { status: 400 }) : compactionResponse()
        : textResponse();
    });
    const h = await codexHarness(factories);
    try {
      await h.session.prompt("/fast on");
      await h.session.prompt("first");
      h.session.setThinkingLevel("high");
      await h.session.prompt("second");
      h.session.setThinkingLevel("max");
      const before = structuredClone(h.sessionManager.getBranch().filter((e) => e.customType === STATE_TYPE));
      // Run the public direct-request event, without installing a failed checkpoint.
      const normal = requests.at(-1);
      const data = { ctx: h.ctx, payload: { ...normal,
        input: [...normal.input.filter((i) => i.type !== "configuration_update"), { type: "compaction_trigger" }],
        reasoning: { effort: "max" },
      } };
      h.api.events.emit("pi-codex-compaction:request:v1", data);
      assert.equal(data.payload.reasoning.effort, "low");
      assert.equal(updates(data.payload).at(-1).reasoning.effort, "max");
      assert.deepEqual(h.sessionManager.getBranch().filter((e) => e.customType === STATE_TYPE), before);
      failCompaction = false;
      await h.session.compact();
      const compact = requests.findLast((r) => r.input.some((i) => i.type === "compaction_trigger"));
      assert.equal(compact.service_tier, "priority");
      assert.equal(compact.reasoning.effort, "low");
      assert.equal(updates(compact).at(-1).reasoning.effort, "max");
      assert.equal(compact.tools.find((t) => t.name === "apply_patch").type, "custom");
      await h.session.prompt("after checkpoint");
      assert.equal(requests.at(-1).reasoning.effort, "max");
      assert.equal(requests.at(-1).input[0].type, "compaction");
      assert.deepEqual(requests.at(-1).input[1], { type: "configuration_update", reasoning: { effort: "max" } });
      h.session.setThinkingLevel("low");
      await h.session.prompt("after checkpoint change");
      assert.deepEqual(updates(requests.at(-1)).map((u) => u.reasoning.effort), ["max", "low"]);
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

test("unsupported models, endpoints, modes and malformed payloads remain untouched", async () => {
  for (const other of [
    { ...model, provider: "openai" }, { ...model, api: "openai-responses" },
    { ...model, id: "gpt-5.5" }, { ...model, id: "gpt-6-astra-pro" },
    { ...model, baseUrl: "https://example.com/backend-api" },
    { ...model, baseUrl: "http://chatgpt.com/backend-api" },
    { ...model, baseUrl: "https://chatgpt.com:444/backend-api" },
  ]) {
    assert.equal(supportsReasoningUpdates(other), false);
    assert.equal(rewriteReasoning(body([user("test")]), other, []), undefined);
  }
  for (const payload of [
    undefined, null, [], { ...body([]), input: "prompt" },
    body([user("test")], "none"), body([user("test")], "minimal"),
    { ...body([user("test")]), reasoning: { effort: "high", mode: "pro" } },
    { ...body([user("test")]), multi_agent: {} },
    { ...body([user("test")]), context_management: [] },
    { ...body([user("test")]), truncation: "auto" },
    { ...body([user("test")]), previous_response_id: "id" },
    { ...body([user("test")]), conversation: "id" },
    body([{ type: "agent_message" }]),
  ]) assert.equal(rewriteReasoning(payload, model, []), undefined);

  const handlers = new Map();
  reasoning({
    on: (name, handler) => handlers.set(name, handler), events: { on() {} },
    appendEntry() { assert.fail("must not persist with API-key authentication"); },
  });
  assert.equal(handlers.get("before_provider_request")({ payload: body([user("test")]) }, {
    model, modelRegistry: { isUsingOAuth: () => false },
  }), undefined);
});

test("malformed persisted state and rewritten history cannot place unchecked updates", () => {
  const first = rewriteReasoning(body([user("first")]), model, []);
  for (const malformed of [
    null, {}, { ...first.state, version: 9 },
    { ...first.state, baseline: "pro" },
    { ...first.state, extra: "must not copy unknown state fields" },
    { ...first.state, last: { ...first.state.last, extra: "not allowed" } },
    { ...first.state, last: { offset: -1, hash: "not a hash" } },
    { ...first.state, updates: [{ offset: 1, hash: "x", effort: "high" }] },
  ]) {
    const result = rewriteReasoning(body([user("rewritten")], "high"), model, [stateEntry(malformed)]);
    assert.equal(result.payload.reasoning.effort, "high");
    assert.deepEqual(updates(result.payload), []);
  }
  const result = rewriteReasoning(body([user("rewritten")], "high"), model, [stateEntry(first.state)]);
  assert.equal(result.payload.reasoning.effort, "high");
  assert.deepEqual(updates(result.payload), []);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(rewriteReasoning(body([cyclic]), model, []), undefined);
  assert.equal(rewriteReasoning(body(Array(20_001).fill(user("x"))), model, []), undefined);
  assert.equal(rewriteReasoning(body([user("x".repeat(16 * 1024 * 1024))]), model, []), undefined);
});

test("a user-authored summary prefix is still fingerprinted as user input", () => {
  const prefix = "The conversation history before this point was compacted into the following summary:";
  const first = rewriteReasoning(body([user(`${prefix} original`)]), model, []);
  const result = rewriteReasoning(body([user(`${prefix} different`)], "high"), model, [stateEntry(first.state)]);
  assert.equal(result.payload.reasoning.effort, "high");
  assert.deepEqual(updates(result.payload), []);
});

test("real compaction failure and cancellation leave saved effort metadata intact", async (t) => {
  let cancel = false;
  let h;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const next = requestBody(init);
    if (!next.input.some((i) => i.type === "compaction_trigger")) return textResponse();
    if (cancel) {
      queueMicrotask(() => h.session.abortCompaction());
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new Error("fixture cancellation"));
        init.signal.addEventListener("abort", abort, { once: true });
        if (init.signal.aborted) abort();
      });
    }
    return new Response("", { status: 400 });
  });
  h = await codexHarness([reasoning, compaction]);
  try {
    await h.session.prompt("first");
    h.session.setThinkingLevel("high");
    await h.session.prompt("second");
    const before = structuredClone(h.sessionManager.getBranch().filter((e) => e.customType === STATE_TYPE));
    cancel = true;
    await assert.rejects(() => h.session.compact(), /cancel|abort/i);
    assert.deepEqual(h.sessionManager.getBranch().filter((e) => e.customType === STATE_TYPE), before);
    assert.equal(h.sessionManager.getBranch().some((e) => e.type === "compaction"), false);
    cancel = false;
    const fallback = await h.session.compact();
    assert.notEqual(fallback.details?.kind, "pi-codex-compaction");
    assert.deepEqual(h.sessionManager.getBranch().filter((e) => e.customType === STATE_TYPE), before);
  } finally { await h.close(); }
});

test("model switches do not apply Astra updates to unsupported models", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(requestBody(init)); return textResponse();
  });
  const h = await codexHarness([reasoning]);
  try {
    await h.session.prompt("first");
    h.session.setThinkingLevel("high");
    await h.session.prompt("second");
    await h.session.setModel(h.modelRuntime.getModel("openai-codex", "gpt-5.5"));
    await h.session.prompt("other model");
    assert.equal(requests.at(-1).reasoning.effort, "high");
    assert.deepEqual(updates(requests.at(-1)), []);
    await h.session.setModel(h.model);
    h.session.setThinkingLevel("medium");
    await h.session.prompt("back");
    assert.equal(updates(requests.at(-1)).at(-1).reasoning.effort, "medium");
  } finally { await h.close(); }
});

test("bounds effort changes and keeps all unrelated fields unchanged", () => {
  let input = [user("start")];
  let result = rewriteReasoning(body(input), model, []);
  for (let n = 0; n < 128; n++) {
    input = [...input, assistant("ok"), user(String(n))];
    const payload = body(input, n % 2 ? "low" : "high");
    const unchanged = structuredClone(payload);
    result = rewriteReasoning(payload, model, [stateEntry(result.state)]);
    assert.deepEqual(payload, unchanged);
    const { input: _i, reasoning: _r, ...other } = result.payload;
    const { input: _j, reasoning: _s, ...expected } = payload;
    assert.deepEqual(other, expected);
    assert.equal(result.payload.reasoning.summary, "auto");
  }
  assert.equal(result.state.updates.length, 128);
  assert.equal(rewriteReasoning(body([...input, assistant("ok"), user("limit")], "max"), model, [stateEntry(result.state)]), undefined);
});
