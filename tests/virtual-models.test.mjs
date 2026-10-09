import assert from "node:assert/strict";
import test from "node:test";
import { createCodemodeExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  eventsResponse, goalState, lastAssistant, routingEntries, toolResponse, usage, virtualHarness,
} from "./virtual-model-harness.mjs";
import { textResponse } from "./codex-harness.mjs";
import { accountUsageFromBranch } from "../packages/pi-goal/src/accounting.ts";
import piFast from "../packages/pi-fast/extensions/index.ts";
import piTools from "../packages/pi-codex-tools/extensions/index.ts";
import piCompaction from "../packages/pi-codex-compaction/extensions/index.ts";
import piReasoning from "../packages/pi-openai-reasoning/extensions/index.ts";
import piGoal from "../packages/pi-goal/extensions/index.ts";

// Real extension wiring, request serializers/parsers, agent loop and session tree.
// Only HTTP/WebSocket and the synthetic classifier implementation are replaced.
const packages = [piFast, piTools, piReasoning, piGoal, piCompaction];
const automaticEntries = (h) => h.sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.details?.kind === "pi-codex-compaction:automatic:v1");
const hasUpdate = (body) => body.input?.some((item) => item.type === "configuration_update") ?? false;
const declarations = (body) => body.tools?.flatMap((tool) => tool.type === "namespace" ? tool.tools : [tool]) ?? [];
const patch = (body) => declarations(body).find((tool) => (tool.name ?? tool.function?.name) === "apply_patch");
const selectedId = (h) => [h.session.model.provider, h.session.model.id];

for (const target of ["public", "codex", "foreign"]) {
  test(`physical ${target} control preserves provider-specific opt-ins`, async (t) => {
    const h = await virtualHarness(t, packages);
    await h.session.prompt("/fast on");
    await h.session.setModel(h.physical(target));
    await h.session.prompt("First physical request.");
    h.session.setThinkingLevel("high");
    await h.session.prompt("Second physical request.");
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].service_tier, target === "public" ? "fast" : target === "codex" ? "priority" : undefined);
    assert.equal(patch(h.requests[0])?.type, target === "foreign" ? undefined : "custom", JSON.stringify(h.requests[0].tools));
    assert.equal(Boolean(h.requests[0].context_management), target === "public");
    assert.equal(hasUpdate(h.requests[1]), target === "codex");
    assert.equal(lastAssistant(h).provider, h.physical(target).provider);
    assert.equal(lastAssistant(h).api, h.physical(target).api);
    assert.equal(goalState(h).tokensUsed, 22);
    assert.deepEqual(h.errors, []);
  });
}

for (const identity of [{ provider: "fixture-router", modelId: "auto" }, { provider: "openai", modelId: "fixture-auto" }]) {
  for (const target of ["public", "codex", "foreign"]) {
    test(`virtual ${identity.provider} → ${target} stays conservative even with Fast enabled`, async (t) => {
      const h = await virtualHarness(t, packages, identity);
      await h.session.prompt("/fast on");
      h.target = target;
      await h.selectVirtual();
      await h.session.prompt("First routed request.");
      h.session.setThinkingLevel("high");
      await h.session.prompt("Second routed request.");
      assert.equal(h.requests.length, 2);
      for (const body of h.requests) {
        assert.equal(body.model, h.physical(target).id);
        assert.equal(body.service_tier, undefined);
        assert.equal(patch(body), undefined, "no grammar capability inferred from a virtual display name");
        for (const name of ["edit", "write"]) {
          assert.ok(declarations(body).some((tool) => (tool.name ?? tool.function?.name) === name), "native declarations remain");
        }
        assert.equal(body.context_management, undefined);
        assert.equal(hasUpdate(body), false);
      }
      assert.deepEqual(selectedId(h), [identity.provider, identity.modelId]);
      assert.ok(h.hooks.every((model) => model.api === "pi-virtual" && model.id === identity.modelId));
      assert.equal(lastAssistant(h).provider, h.physical(target).provider);
      assert.equal(lastAssistant(h).api, h.physical(target).api);
      assert.equal(lastAssistant(h).model, h.physical(target).id);
      if (target !== "foreign") assert.deepEqual(h.streams.at(-1), {
        provider: h.physical(target).provider, api: h.physical(target).api, model: h.physical(target).id,
      }, "stream observation has physical identity, but is too late to prepare this request");
      assert.equal(lastAssistant(h).thinkingLevel, target === "foreign" ? "off" : "low");
      assert.equal(h.routes.at(-1).thinkingLevel, "high", "selected thinking and routed thinking stay distinct");
      assert.equal(goalState(h).tokensUsed, 22);
      assert.equal(automaticEntries(h).length, 0);
      assert.deepEqual(h.errors, []);
    });
  }
}

test("physical checkpoints become readable fallback, never opaque replay, behind a virtual selection", async (t) => {
  const h = await virtualHarness(t, packages);
  h.replies.push(() => eventsResponse([
    { type: "response.created", response: { id: "resp_checkpoint", status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: { id: "cmp_fixture", type: "compaction", encrypted_content: "fixture-checkpoint" } },
    { type: "response.completed", response: { id: "resp_checkpoint", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ]));
  await h.session.prompt("Keep this readable checkpoint context.");
  assert.equal(automaticEntries(h).length, 1);
  await h.selectVirtual();
  for (const target of ["foreign", "public", "codex"]) {
    h.target = target;
    await h.session.prompt("Continue without opaque replay.");
    const body = h.requests.at(-1);
    assert.ok(!JSON.stringify(body).includes("fixture-checkpoint"));
    assert.match(JSON.stringify(body), /readable checkpoint context/);
    assert.equal(body.context_management, undefined);
  }
  assert.equal(automaticEntries(h).length, 1, "routing does not create another checkpoint");
  await h.session.reload();
  h.target = "public";
  await h.session.prompt("Reload must not infer an eligible compaction identity.");
  assert.ok(!JSON.stringify(h.requests.at(-1)).includes("fixture-checkpoint"));
  assert.equal(goalState(h).tokensUsed, 55);
  assert.deepEqual(h.errors, []);
});

test("routing state, selected identity and goal totals restore across reload, tree and a forked branch", async (t) => {
  const h = await virtualHarness(t, packages);
  await h.selectVirtual();
  await h.session.prompt("Branch origin.");
  const origin = h.sessionManager.getLeafId();
  await h.session.reload();
  h.target = "foreign";
  await h.session.prompt("Abandoned branch.");
  assert.equal(h.routes.at(-1).state.visits, 1);
  assert.equal(goalState(h).tokensUsed, 22);
  await h.session.navigateTree(origin, { summarize: false });
  h.target = "codex";
  await h.session.prompt("Alternate branch.");
  assert.equal(h.routes.at(-1).state.visits, 1, "does not inherit abandoned router state");
  assert.equal(goalState(h).tokensUsed, 22);
  const forkManager = SessionManager.inMemory("/tmp", { id: "virtual-fork-fixture" }, structuredClone(h.sessionManager.getBranch()));
  const fork = await virtualHarness(t, packages, { sessionManager: forkManager });
  await fork.selectVirtual();
  fork.target = "foreign";
  await fork.session.prompt("Fork only.");
  assert.equal(fork.routes[0].state.visits, 2);
  assert.equal(goalState(fork).tokensUsed, 33);
  assert.equal(goalState(h).tokensUsed, 22);
  assert.deepEqual(selectedId(fork), ["fixture-router", "auto"]);
  assert.equal(accountUsageFromBranch(goalState(fork), fork.sessionManager.getBranch()).addedTokens, 0);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(fork.errors, []);
});

test("router sees user, tool continuation, retry, and direct summary calls without changing selected model", async (t) => {
  const action = (pi) => pi.registerTool({
    name: "fixture_noop", label: "Fixture", description: "No OS side effects.", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ok" }], details: undefined }; },
  });
  const h = await virtualHarness(t, [...packages, action], {
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  await h.selectVirtual();
  h.replies.push(
    (body) => toolResponse("fixture_noop", {}, body),
    () => textResponse(),
    () => {
      h.target = "foreign"; // A new preference must not change this turn's retry.
      return eventsResponse([{ type: "response.failed", response: { status: "failed", error: { code: "overloaded_error", message: "overloaded_error" } } }]);
    },
    () => textResponse(),
  );
  await h.session.prompt("Exercise tool continuation.");
  await h.session.prompt("Exercise retry.");
  assert.equal(h.requests[3].model, h.physical("public").id);
  h.target = "public";
  await h.session.compact();
  assert.deepEqual(h.routes.map((route) => route.reason), ["user", "continuation", "user", "retry", "direct"]);
  assert.equal(h.routes[1].previous.model.provider, "openai");
  assert.equal(h.routes[3].failed.model.provider, "openai");
  assert.equal(h.routes[4].state, undefined);
  assert.equal(routingEntries(h).length, 4, "direct summary routing does not persist its returned state");
  assert.deepEqual(selectedId(h), ["fixture-router", "auto"]);
  assert.ok(h.sessionManager.getBranch().some((entry) => entry.type === "compaction"));
  assert.equal(h.requests.length, 6, "history and split-prefix summaries share one direct route");
  assert.deepEqual(h.errors, []);
});

test("sticky tool continuation retains its physical thinking signature; a cross-provider turn drops it", async (t) => {
  const action = (pi) => pi.registerTool({
    name: "fixture_noop", label: "Fixture", description: "Change the next user route only.", parameters: Type.Object({}),
    async execute() {
      h.target = "foreign";
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });
  const h = await virtualHarness(t, [...packages, action]);
  await h.selectVirtual();
  h.replies.push(async (body) => {
    const reasoning = {
      type: "reasoning", id: "rs_fixture", encrypted_content: "synthetic-thinking-signature",
      summary: [{ type: "summary_text", text: "Synthetic readable thought." }],
    };
    const thinking = await eventsResponse([
      { type: "response.output_item.added", output_index: 1, item: reasoning },
      { type: "response.output_item.done", output_index: 1, item: reasoning },
    ]).text();
    return new Response(thinking + await toolResponse("fixture_noop", {}, body).text(), {
      headers: { "content-type": "text/event-stream" },
    });
  }, () => textResponse());
  await h.session.prompt("Use the same physical model for a tool continuation.");
  assert.equal(h.routes[1].reason, "continuation");
  assert.equal(h.requests[1].model, h.physical("public").id);
  assert.ok(h.requests[1].input.some((item) => item.encrypted_content === "synthetic-thinking-signature"));
  await h.session.prompt("The next user turn can change providers.");
  assert.equal(h.requests[2].model, "tiny");
  assert.doesNotMatch(JSON.stringify(h.requests[2]), /synthetic-thinking-signature|rs_fixture/);
  assert.match(JSON.stringify(h.requests[2]), /Synthetic readable thought/);
  assert.equal(goalState(h).tokensUsed, 33);
  assert.deepEqual(h.errors, []);
});

test("a smaller routed context window triggers ordinary Pi compaction before dispatch", async (t) => {
  const boundaries = [];
  const summary = (pi) => pi.on("session_before_compact", (event) => {
    boundaries.push(event.reason);
    return { compaction: {
      summary: "Small synthetic summary.", firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore, usage: usage(7),
    } };
  });
  const h = await virtualHarness(t, [...packages, summary]);
  await h.selectVirtual();
  h.replies.push(async () => new Response(
    (await textResponse().text()).replace('"input_tokens":10', '"input_tokens":10000').replace('"total_tokens":11', '"total_tokens":10001'),
    { headers: { "content-type": "text/event-stream" } },
  ));
  await h.session.prompt("Large-model fixture history. ".repeat(1800));
  h.session.settingsManager.setCompactionEnabled(true);
  h.target = "foreign";
  await h.session.prompt("Now route to the small model.");
  assert.deepEqual(boundaries, ["threshold"]);
  assert.equal(h.requests.length, 2);
  assert.match(JSON.stringify(h.requests[1].messages), /Small synthetic summary/);
  assert.equal(lastAssistant(h).model, "tiny");
  assert.equal(goalState(h).tokensUsed, 10019);
  assert.equal(automaticEntries(h).length, 0);
  assert.deepEqual(h.errors, []);
});

function classifier(calls, implementation) {
  return (pi) => pi.registerProvider("fixture-classifier", {
    apiKey: "synthetic-classifier-key",
    models: [{
      type: "classifier", id: "judgment", name: "Synthetic classifier", input: ["text"],
      api: "fixture-classify", baseUrl: "https://classifier.invalid", contextWindow: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    classifiers: { "fixture-classify": {
      async classify(model, context, options) {
        assert.equal(model.baseUrl, "https://classifier.invalid");
        assert.ok(options.apiKey === "synthetic-classifier-key", "classifier must use its own fixture credential");
        calls.push({ context, signal: options.signal });
        if (implementation) return implementation(model, context, options);
        return {
          api: model.api, model: model.id, provider: model.provider, stopReason: "stop", usage: usage(42), timestamp: Date.now(),
          answers: Object.fromEntries(Object.keys(context.questions).map((key) => [
            key, { type: "choice", choice: "public", probabilities: { public: 0.9, foreign: 0.1 }, confidence: 0.9 },
          ])),
        };
      },
    } },
  });
}
const judgment = {
  state: { input: "Synthetic bounded request." },
  questions: { target: {
    type: "choice", instructions: "Fixture only: choose one physical model; no authorization decision.",
    criteria: { public: "Public fixture", foreign: "Other fixture" },
  } },
};

test("characterization: raw classifier usage in a router is not automatically a goal/session ledger entry", async (t) => {
  const calls = [];
  const h = await virtualHarness(t, [...packages, classifier(calls)], {
    route: async (request, ctx, harness) => {
      const model = ctx.modelRegistry.getModelOfType("classifier", "fixture-classifier", "judgment");
      const result = await ctx.modelRegistry.classify(model, judgment, { signal: request.signal });
      assert.equal(result.stopReason, "stop");
      assert.equal(result.usage.totalTokens, 42);
      return { model: harness.physical(result.answers.target.choice), state: { routed: true } };
    },
  });
  await h.selectVirtual();
  await h.session.prompt("Classify only in the router.");
  assert.equal(calls.length, 1);
  assert.equal(goalState(h).tokensUsed, 11, "characterizes missing attribution, NOT free classification");
  assert.ok(!h.sessionManager.getBranch().some((entry) => entry.type === "usage"));
  assert.equal(h.session.getSessionStats().tokens.total, 11);
  assert.equal(accountUsageFromBranch(goalState(h), h.sessionManager.getBranch()).addedTokens, 0);
  // A full SDK session owner can record usage. This is a test control, not a
  // production extension workaround: ctx.sessionManager is read-only.
  h.sessionManager.appendUsage("classifier_fixture", "fixture-classifier", "judgment", usage(42));
  await h.session.reload();
  assert.equal(goalState(h).tokensUsed, 53);
  assert.equal(h.session.getSessionStats().tokens.total, 53);
  assert.equal(accountUsageFromBranch(goalState(h), h.sessionManager.getBranch()).addedTokens, 0);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.errors, []);
});

test("codemode classifier usage is attributed once, including reload; judgments cannot bypass approval or model-only tools", async (t) => {
  const calls = [];
  let executed = 0;
  let approvalCalls = 0;
  const guard = (pi) => {
    pi.registerTool({
      name: "fixture_action", label: "Fixture", description: "Approval-gated no-op.", parameters: Type.Object({}),
      async execute() { executed++; return { content: [{ type: "text", text: "unexpected" }], details: undefined }; },
    });
    pi.on("tool_call", (event) => {
      if (event.toolName === "fixture_action") { approvalCalls++; return { block: true, reason: "Fixture approval denied" }; }
    });
  };
  const h = await virtualHarness(t, [
    createCodemodeExtension({ mode: "only" }), ...packages, classifier(calls), guard,
  ], { settings: { defaultTools: ["codemode"] } });
  await h.selectVirtual();
  const code = `
    const model = await models.getModelOfType("classifier", "fixture-classifier", "judgment");
    const result = await models.classify({...model, baseUrl: "https://wrong.invalid", headers: {Authorization: "wrong"}}, ${JSON.stringify(judgment)});
    if (result.answers.target.choice !== "public") throw new Error("Missing typed result");
    try { await tools.fixture_action({}); } catch { text("approval retained"); }
    if ("update_goal" in tools) throw new Error("Model-only tool leaked");
    text("typed classification");
  `;
  h.replies.push((body) => toolResponse("codemode", { code }, body), () => textResponse());
  await h.session.prompt("Use a classifier without changing authority.");
  const result = h.session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert.equal(result?.isError, false, JSON.stringify(result?.content));
  assert.equal(calls.length, 1);
  assert.equal(executed, 0);
  assert.equal(approvalCalls, 1);
  assert.equal(result.usage.totalTokens, 42);
  assert.equal(goalState(h).tokensUsed, 64);
  assert.equal(goalState(h).status, "paused");
  await h.session.reload();
  assert.equal(goalState(h).tokensUsed, 64);
  assert.equal(accountUsageFromBranch(goalState(h), h.sessionManager.getBranch()).addedTokens, 0);
  assert.deepEqual(h.errors, []);
});

for (const outcome of ["error", "abort"]) {
  test(`classifier ${outcome} during routing is explicit and starts no physical request`, { timeout: 10_000 }, async (t) => {
    const calls = [];
    const entered = Promise.withResolvers();
    let result;
    const h = await virtualHarness(t, [
      ...packages,
      classifier(calls, async (_model, _context, { signal }) => {
        if (outcome === "error") throw new Error("Synthetic classifier failure");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Synthetic classifier cancelled")), { once: true });
          entered.resolve();
        });
      }),
    ], {
      route: async (request, ctx) => {
        result = await ctx.modelRegistry.classify(
          ctx.modelRegistry.getModelOfType("classifier", "fixture-classifier", "judgment"),
          judgment, { signal: request.signal },
        );
        assert.notEqual(result.stopReason, "stop");
        throw new Error(`Routing did not complete: ${result.stopReason}`);
      },
    });
    await h.selectVirtual();
    const run = h.session.prompt("Do not silently route after classifier failure.");
    if (outcome === "abort") { await entered.promise; await h.session.abort(); }
    await run;
    assert.equal(calls.length, 1);
    assert.equal(result.stopReason, outcome === "abort" ? "aborted" : "error");
    assert.equal(lastAssistant(h).stopReason, outcome === "abort" ? "aborted" : "error");
    assert.equal(h.requests.length, 0);
    assert.equal(routingEntries(h).length, 0);
    assert.equal(goalState(h).status, "paused");
    assert.equal(goalState(h).tokensUsed, 0, "no usage was reported; not evidence that a live failure would be free");
    assert.deepEqual(h.errors, []);
  });
}

// Candidate consumer only, never installed as a tool/router. A classifier may
// reorder three bounded snippets; it cannot invent IDs, authorize actions, or
// change a goal. Synthetic scores exercise plumbing, not relevance quality.
function rankingScript(enabled, modelId = "judgment") {
  return `// @options: {"timeout_ms": 5000, "max_output_tokens": 200}
    const candidates = [
      {id: "a", snippet: "First synthetic search result."},
      {id: "b", snippet: "Second synthetic search result."},
      {id: "c", snippet: "Third synthetic search result."},
      {id: "d", snippet: "Out of the bounded sample."},
    ];
    const original = candidates.map(item => item.id);
    if (!${enabled}) { text({order: original, outcome: "disabled"}); return; }
    const model = await models.getModelOfType("classifier", "fixture-classifier", "${modelId}");
    if (!model) { text({order: original, outcome: "unavailable"}); return; }
    const scores = [];
    for (const item of candidates.slice(0, 3)) {
      const result = await models.classify(model, {
        state: {query: "Synthetic documentation question", snippet: item.snippet.slice(0, 256)},
        questions: {relevance: {type: "score", instructions: "Rank only; never authorize an action",
          criteria: ["unrelated", "partly relevant", "directly relevant"]}},
      });
      const answer = result?.answers?.relevance;
      if (result?.stopReason !== "stop" || answer?.type !== "score" ||
          !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 2 ||
          !Number.isFinite(answer.confidence) || answer.confidence < 0.8 || answer.confidence > 1) {
        text({order: original, outcome: "fallback"}); return;
      }
      scores.push({id: item.id, score: answer.score});
    }
    scores.sort((a, b) => b.score - a.score);
    text({order: [...scores.map(item => item.id), ...original.slice(3)], outcome: "ranked"});
  `;
}

for (const outcome of ["disabled", "unavailable", "ranked", "low-confidence", "malformed", "error"]) {
  test(`test-only snippet ranking: ${outcome} is bounded and does not grant authority`, async (t) => {
    const calls = [];
    const h = await virtualHarness(t, [
      createCodemodeExtension({ mode: "only" }), ...packages,
      classifier(calls, async (model) => ({
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: outcome === "error" ? "error" : "stop",
        ...(outcome === "error" ? { errorMessage: "Synthetic provider failure" } : {}),
        usage: usage(42), answers: { relevance: {
          type: "score", score: outcome === "malformed" ? 3 : calls.length === 2 ? 2 : 0,
          confidence: outcome === "low-confidence" ? 0.2 : 0.9,
        } },
      })),
    ], { settings: { defaultTools: ["codemode"] } });
    await h.selectVirtual();
    const code = rankingScript(outcome !== "disabled", outcome === "unavailable" ? "missing" : "judgment");
    h.replies.push((body) => toolResponse("codemode", { code }, body), () => textResponse());
    await h.session.prompt("Evaluate bounded ranking only.");
    const result = h.session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.equal(result?.isError, false, JSON.stringify(result?.content));
    const output = result.content.map((block) => block.text ?? "").join("\n");
    assert.match(output, outcome === "ranked" ? /"order":\["b","a","c","d"\]/ : /"order":\["a","b","c","d"\]/);
    assert.match(output, new RegExp(`"outcome":"${["disabled", "unavailable", "ranked"].includes(outcome) ? outcome : "fallback"}"`));
    const count = ["disabled", "unavailable"].includes(outcome) ? 0 : outcome === "ranked" ? 3 : 1;
    assert.equal(calls.length, count, "no retries, fallback model, or extra candidates");
    assert.ok(calls.every((call) => JSON.stringify(call.context).length < 512));
    assert.equal(result.usage?.totalTokens ?? 0, count * 42);
    assert.equal(goalState(h).tokensUsed, 22 + count * 42);
    assert.equal(goalState(h).status, "paused");
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.errors, []);
  });
}

test("aborting codemode cancels classification while keeping earlier reported usage once", { timeout: 10_000 }, async (t) => {
  const calls = [];
  const entered = Promise.withResolvers();
  let cancelled = false;
  const h = await virtualHarness(t, [
    createCodemodeExtension({ mode: "only" }), ...packages,
    classifier(calls, async (model, _context, { signal }) => {
      if (calls.length === 1) return {
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: "stop", usage: usage(42), answers: { accepted: { type: "bool", probability: 0.7 } },
      };
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          cancelled = true;
          reject(new Error("Synthetic classifier cancelled"));
        }, { once: true });
        entered.resolve();
      });
    }),
  ], { settings: { defaultTools: ["codemode"] } });
  await h.selectVirtual();
  const code = `
    const model = await models.getModelOfType("classifier", "fixture-classifier", "judgment");
    const context = {state: {text: "Synthetic"}, questions: {
      accepted: {type: "bool", instructions: "Fixture judgment, not permission", criteria: {true: "yes", false: "no"}},
    }};
    const first = await models.classify(model, context);
    if (first.answers.accepted.probability !== 0.7) throw new Error("Missing typed probability");
    text("first reported usage");
    const pending = await models.classify(model, context);
    text(pending.stopReason);
  `;
  h.replies.push((body) => toolResponse("codemode", { code }, body));
  const run = h.session.prompt("Cancel the second synthetic classifier call.");
  await entered.promise;
  await h.session.abort();
  await run;
  const result = h.session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert.equal(cancelled, true);
  assert.equal(result?.isError, true);
  assert.equal(result.usage.totalTokens, 42);
  assert.equal(goalState(h).tokensUsed, 53);
  assert.equal(goalState(h).status, "paused");
  assert.equal(h.requests.length, 1);
  assert.equal(accountUsageFromBranch(goalState(h), h.sessionManager.getBranch()).addedTokens, 0);
  assert.deepEqual(h.errors, []);
});
