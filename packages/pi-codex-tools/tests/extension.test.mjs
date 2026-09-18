import assert from "node:assert/strict";
import test from "node:test";

process.env.CI = "1";

const { default: piCodexTools } = await import("../extensions/index.ts");
const { supportsOpenAIGrammarTools } = await import("../src/model-support.ts");

function makePi(initialActive = ["read", "write", "edit", "bash"]) {
  const handlers = new Map();
  const tools = new Map();
  let active = [...initialActive];
  return {
    handlers,
    tools,
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names) {
      active = [...names];
    },
  };
}

async function applyProviderRequestHooks(pi, payload, context) {
  let nextPayload = payload;
  for (const handler of pi.handlers.get("before_provider_request") ?? []) {
    const result = await handler({ payload: nextPayload }, context);
    if (result !== undefined) nextPayload = result;
  }
  return nextPayload;
}

const codexModel = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.5",
  compat: { supportsOpenAIGrammarTools: true },
};

const ordinaryModel = {
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-sonnet",
  compat: {},
};

test("requires both a Responses API and the advertised grammar capability", () => {
  assert.equal(supportsOpenAIGrammarTools(codexModel), true);
  assert.equal(supportsOpenAIGrammarTools({ ...codexModel, api: "openai-completions" }), false);
  assert.equal(supportsOpenAIGrammarTools({ ...codexModel, compat: {} }), false);
  assert.equal(supportsOpenAIGrammarTools(ordinaryModel), false);
});

test("replaces edit and write while preserving unrelated active tools", async () => {
  const pi = makePi();
  piCodexTools(pi);
  const context = { model: codexModel };

  await pi.handlers.get("session_start")[0]({}, context);
  assert.deepEqual(pi.getActiveTools(), ["read", "bash", "apply_patch"]);

  assert.equal(pi.tools.get("apply_patch").executionMode, "sequential");
  assert.deepEqual(
    await applyProviderRequestHooks(pi, { model: codexModel.id, parallel_tool_calls: true }, context),
    { model: codexModel.id, parallel_tool_calls: true },
  );

  await pi.handlers.get("model_select")[0]({}, { model: ordinaryModel });
  assert.deepEqual(pi.getActiveTools(), ["read", "bash", "edit", "write"]);
});

test("rejects apply_patch execution for unsupported models", async () => {
  const pi = makePi();
  piCodexTools(pi);
  const tool = pi.tools.get("apply_patch");
  await assert.rejects(
    tool.execute("call", { patch: "*** Begin Patch\n*** End Patch" }, undefined, undefined, { model: ordinaryModel, cwd: process.cwd() }),
    /only available for OpenAI models that advertise grammar-tool support/,
  );
});

test("restores only file tools that were active before replacement", async () => {
  const pi = makePi(["read", "edit", "bash"]);
  piCodexTools(pi);
  const context = { model: codexModel };

  await pi.handlers.get("session_start")[0]({}, context);
  assert.deepEqual(pi.getActiveTools(), ["read", "bash", "apply_patch"]);

  await pi.handlers.get("model_select")[0]({}, { model: ordinaryModel });
  assert.deepEqual(pi.getActiveTools(), ["read", "bash", "edit"]);
});

test("activates GPT-6 Astra based on capability, without a native filesystem binding", async () => {
  const pi = makePi();
  piCodexTools(pi);

  for (const api of ["openai-responses", "openai-codex-responses"]) {
    const model = { ...codexModel, id: "gpt-6-astra", api };
    await pi.handlers.get("session_start")[0]({}, { model });
    assert.deepEqual(pi.getActiveTools(), ["read", "bash", "apply_patch"]);
    await pi.handlers.get("model_select")[0]({}, { model: { ...model, compat: {} } });
    assert.deepEqual(pi.getActiveTools(), ["read", "bash", "edit", "write"]);
  }
});

test("exposes apply_patch as a raw grammar tool", () => {
  const pi = makePi();
  piCodexTools(pi);
  const tool = pi.tools.get("apply_patch");
  assert.equal(tool.constrainedSampling.type, "grammar");
  assert.match(tool.constrainedSampling.variants.openai_lark, /start: begin_patch hunk\+ end_patch/);
  assert.match(tool.description, /FREEFORM/);
});
