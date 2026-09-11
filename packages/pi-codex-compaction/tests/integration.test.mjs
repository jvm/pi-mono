import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { codexHarness, compactionResponse, requestBody, textResponse } from "../../../tests/codex-harness.mjs";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";
beforeEach((t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network request blocked"); });
});
const { default: fast } = await import("../../pi-fast/extensions/index.ts");
const { default: tools } = await import("../../pi-codex-tools/extensions/index.ts");
const { default: compaction } = await import("../extensions/index.ts");
const { COMPACTION_FALLBACK_ENTRY } = await import("../src/index.ts");
const zeroUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const patch = "*** Begin Patch\n*** Add File: unused.txt\n+fixture\n*** End Patch";

for (const factories of [[fast, tools, compaction], [compaction, tools, fast]]) {
  test(`real Pi compaction preserves grammar history, Fast, usage and checkpoint (${factories[0].name} first)`, async (t) => {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requests.push(requestBody(init));
      return compactionResponse({
        input_tokens: 100, output_tokens: 5, total_tokens: 105,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
      });
    });
    const h = await codexHarness(factories);
    try {
      // Verify the upstream gap as well as the package bridge.
      assert.equal(h.api.getAllTools().find((t) => t.name === "apply_patch").constrainedSampling, undefined);
      assert.ok(h.session.getActiveToolNames().includes("apply_patch"));
      const messages = [
        { role: "user", content: "old request", timestamp: 1 },
        {
          role: "assistant", provider: h.model.provider, api: h.model.api, model: h.model.id,
          content: [{ type: "toolCall", id: "call_1|fc_1", name: "apply_patch", arguments: { patch } }],
          usage: zeroUsage, stopReason: "toolUse", timestamp: 2,
        },
        { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "apply_patch", content: [{ type: "text", text: "fixture result" }], isError: false, timestamp: 3 },
        { role: "user", content: "kept request", timestamp: 4 },
      ];
      for (const message of messages) h.sessionManager.appendMessage(message);
      h.session.agent.state.messages = messages;
      await h.session.prompt("/fast on");
      const result = await h.session.compact();
      assert.equal(requests.length, 1);
      const body = requests[0];
      assert.equal(body.service_tier, "priority");
      assert.equal(body.reasoning.effort, "low");
      assert.equal(body.tools.find((t) => t.name === "apply_patch").type, "custom");
      const call = body.input.find((item) => item.type === "custom_tool_call");
      assert.equal(call.input, patch);
      assert.equal(call.call_id, "call_1");
      assert.equal(body.input.find((item) => item.type === "custom_tool_call_output").output, "fixture result");
      assert.equal(body.input.at(-1).type, "compaction_trigger");
      assert.equal(JSON.stringify(body.input).includes("kept request"), false);
      assert.deepEqual(
        { ...result.usage, cost: undefined },
        { input: 50, output: 5, cacheRead: 20, cacheWrite: 30, totalTokens: 105, cost: undefined },
      );
      const entry = h.sessionManager.getBranch().findLast((e) => e.type === "compaction");
      assert.deepEqual(entry.usage, result.usage);
      assert.equal(entry.details.usage.cacheWriteInputTokens, 30);
      assert.ok(h.session.getSessionStats().tokens.cacheWrite >= 30);
      assert.deepEqual(h.errors, []);

      // A subsequent request goes through the actual provider hook chain.
      let replay;
      h.api.on("before_provider_request", (event) => { replay = event.payload; });
      // Mock provider transport, after the extension runner rewrites it.
      t.mock.method(globalThis, "fetch", async (_url, init) => {
        const next = requestBody(init);
        if (next.input) replay = next;
        return textResponse();
      });
      await h.session.prompt("continue", { expandPromptTemplates: false });
      assert.ok(replay.input.some((item) => item.type === "compaction"));
      assert.equal(replay.service_tier, "priority");
      assert.equal(h.session.messages.at(-1).stopReason, "stop");
    } finally { await h.close(); }
  });
}

test("a remote rejection uses the actual standard Pi compactor", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = requestBody(init);
    requests.push(body);
    return body.input.some((item) => item.type === "compaction_trigger")
      ? new Response("fixture rejection", { status: 400 })
      : textResponse("fallback summary");
  });
  const h = await codexHarness([compaction]);
  try {
    for (const [index, content] of ["old request", "kept request"].entries()) {
      h.sessionManager.appendMessage({ role: "user", content, timestamp: index + 1 });
    }
    const result = await h.session.compact();
    assert.equal(result.summary, "fallback summary");
    assert.notEqual(result.details?.kind, "pi-codex-compaction");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].input.some((item) => item.type === "compaction_trigger"), false);
    assert.deepEqual(h.sessionManager.getBranch().find((entry) => entry.customType === COMPACTION_FALLBACK_ENTRY)?.data, {
      version: 1, reason: "remote-failed",
    });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("real Pi uses remote compaction when transcript bytes exceed the token budget", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = requestBody(init);
    requests.push(body);
    return body.input.some((item) => item.type === "compaction_trigger")
      ? compactionResponse()
      : textResponse("unexpected standard fallback");
  });
  const h = await codexHarness([compaction]);
  try {
    // Synthetic history: no private session text or encrypted provider data.
    const oldText = "Keep the implementation and regression tests consistent.\n".repeat(6_000);
    const tokenBudget = h.model.contextWindow - 8_192;
    assert.ok(Buffer.byteLength(oldText) > tokenBudget);
    for (const [index, content] of [oldText, "kept request"].entries()) {
      h.sessionManager.appendMessage({ role: "user", content, timestamp: index + 1 });
    }
    const result = await h.session.compact();
    assert.equal(result.details?.kind, "pi-codex-compaction");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input.at(-1).type, "compaction_trigger");
    assert.ok(requests[0].input.some((item) => JSON.stringify(item).includes(oldText.slice(0, 50))));
    assert.equal(JSON.stringify(requests[0].input).includes("kept request"), false);
    assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction").fromHook, true);
    assert.equal(h.sessionManager.getBranch().some((entry) => entry.customType === COMPACTION_FALLBACK_ENTRY), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("real Pi records a size fallback and keeps its diagnostic out of later model input", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = requestBody(init);
    requests.push(body);
    assert.equal(body.input.some((item) => item.type === "compaction_trigger"), false);
    return textResponse("standard summary");
  });
  const h = await codexHarness([compaction]);
  try {
    await h.session.setModel({ ...h.model, contextWindow: 20_000 });
    for (const [index, content] of ["PRIVATE_HISTORY ".repeat(6_000), "kept request"].entries()) {
      h.sessionManager.appendMessage({ role: "user", content, timestamp: index + 1 });
    }
    const result = await h.session.compact();
    assert.equal(result.summary, "standard summary");
    assert.equal(requests.length, 1);
    const branch = h.sessionManager.getBranch();
    const data = branch.find((entry) => entry.customType === COMPACTION_FALLBACK_ENTRY)?.data;
    assert.equal(data.reason, "context-limit");
    assert.ok(data.estimatedTokens > data.tokenBudget);
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE_HISTORY|acct_fixture|test-signature/);
    assert.equal(branch.findLast((entry) => entry.type === "compaction").fromHook, false);
    await h.session.prompt("continue", { expandPromptTemplates: false });
    assert.equal(requests.length, 2);
    assert.equal(JSON.stringify(requests[1]).includes(COMPACTION_FALLBACK_ENTRY), false);
    assert.equal(JSON.stringify(requests[1]).includes("estimatedTokens"), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("real Pi sizes the envelope after a cooperating extension removes fields", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = requestBody(init);
    requests.push(body);
    return body.input.some((item) => item.type === "compaction_trigger")
      ? compactionResponse()
      : textResponse("unexpected standard fallback");
  });
  const h = await codexHarness([compaction, (pi) => {
    pi.events.on("pi-codex-compaction:tools:v1", (data) => {
      assert.ok(data.tools.length > 0);
      data.tools = [{ ...data.tools[0], description: "omitted schema ".repeat(8_000) }];
    });
    pi.events.on("pi-codex-compaction:request:v1", (data) => {
      delete data.payload.instructions;
      delete data.payload.tools;
    });
  }]);
  try {
    await h.session.setModel({ ...h.model, contextWindow: 20_000 });
    for (const [index, content] of ["old request", "kept request"].entries()) {
      h.sessionManager.appendMessage({ role: "user", content, timestamp: index + 1 });
    }
    const result = await h.session.compact();
    assert.equal(result.details?.kind, "pi-codex-compaction");
    assert.equal(requests.length, 1);
    assert.equal(Object.hasOwn(requests[0], "instructions"), false);
    assert.equal(Object.hasOwn(requests[0], "tools"), false);
    assert.equal(requests[0].input.at(-1).type, "compaction_trigger");
    assert.equal(JSON.stringify(requests[0].input).includes("kept request"), false);
    assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction").fromHook, true);
    assert.equal(h.sessionManager.getBranch().some((entry) => entry.customType === COMPACTION_FALLBACK_ENTRY), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
