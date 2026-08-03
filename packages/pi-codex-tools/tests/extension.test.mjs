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

  const rewritten = await pi.handlers.get("before_provider_request")[0](
    { payload: { model: codexModel.id, parallel_tool_calls: true } },
    context,
  );
  assert.deepEqual(rewritten, { model: codexModel.id, parallel_tool_calls: false });

  await pi.handlers.get("model_select")[0]({}, { model: ordinaryModel });
  assert.deepEqual(pi.getActiveTools(), ["read", "bash", "edit", "write"]);
  assert.equal(await pi.handlers.get("before_provider_request")[0]({ payload: { parallel_tool_calls: true } }, { model: ordinaryModel }), undefined);
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

test("exposes apply_patch as a raw grammar tool", () => {
  const pi = makePi();
  piCodexTools(pi);
  const tool = pi.tools.get("apply_patch");
  assert.equal(tool.constrainedSampling.type, "grammar");
  assert.match(tool.constrainedSampling.variants.openai_lark, /start: begin_patch hunk\+ end_patch/);
  assert.match(tool.description, /FREEFORM/);
});
