import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";

process.env.CI = "1";
const { default: piCodexTools } = await import("../extensions/index.ts");
const { APPLY_PATCH_GRAMMAR } = await import("../src/apply-patch.ts");

// Synthetic auth for the mocked transport. No real credentials or network calls.
const codexToken = `test.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.test`;

for (const [catalog, stream, apiKey] of [
  [OPENAI_MODELS, streamResponses, "test-only"],
  [OPENAI_CODEX_MODELS, streamCodex, codexToken],
]) {
  const model = catalog["gpt-6-astra"];
  test(`Astra grammar transport and symlink execution: ${model?.api}`, { timeout: 15_000 }, async () => {
    assert.ok(model, "Pinned Pi catalog must include GPT-6 Astra");
    assert.equal(model.compat.supportsOpenAIGrammarTools, true);
    const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-astra-"));
    try {
      await mkdir(join(cwd, "real"));
      await symlink(join(cwd, "real"), join(cwd, "tmp"), "junction");
      const path = join(cwd, "tmp", "fixture.md");
      const patch = `*** Begin Patch\n*** Add File: ${path}\n+created by a raw patch\n*** End Patch`;
      const tools = new Map();
      const handlers = new Map();
      let active = ["read", "write", "edit", "bash"];
      piCodexTools({
        registerTool: (tool) => tools.set(tool.name, tool),
        on: (name, handler) => handlers.set(name, handler),
        getActiveTools: () => active,
        setActiveTools: (names) => { active = names; },
      });
      const context = { cwd, model, mode: "print", hasUI: false };
      await handlers.get("session_start")({}, context);
      assert.deepEqual(active, ["read", "bash", "apply_patch"]);
      const tool = tools.get("apply_patch");
      const item = { type: "custom_tool_call", id: "ct_patch", call_id: "call_patch", name: "apply_patch", input: patch };
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
        { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: item.id, delta: patch },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      let requestCount = 0;
      const options = {
        apiKey,
        transport: "sse",
        reasoningEffort: "low",
        maxRetries: 0,
        onPayload: (body) => {
          assert.equal(body.model, "gpt-6-astra");
          assert.notEqual(body.parallel_tool_calls, false);
          assert.equal(body.tools[0].type, "custom");
          assert.deepEqual(body.tools[0].format, { type: "grammar", syntax: "lark", definition: APPLY_PATCH_GRAMMAR });
          assert.equal(body.tools[0].parameters, undefined);
          if (requestCount === 1) {
            assert.equal(body.input.find((item) => item.type === "custom_tool_call").input, patch);
            assert.match(body.input.find((item) => item.type === "custom_tool_call_output").output, /Applied patch/);
          }
        },
        fetch: async () => {
          requestCount++;
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      };
      const messages = [{ role: "user", content: "Create the fixture", timestamp: Date.now() }];
      const response = await stream(model, { messages, tools: [tool] }, options).result();
      assert.equal(response.stopReason, "toolUse", response.errorMessage);
      const call = response.content.find((block) => block.type === "toolCall");
      assert.deepEqual(call.arguments, { patch });
      const result = await tool.execute(call.id, call.arguments, undefined, undefined, context);
      assert.equal(await readFile(join(cwd, "real", "fixture.md"), "utf8"), "created by a raw patch\n");
      assert.ok((await lstat(join(cwd, "tmp"))).isSymbolicLink());
      messages.push(response, {
        role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: result.content, isError: false, timestamp: Date.now(),
      });
      const replay = await stream(model, { messages, tools: [tool] }, options).result();
      assert.equal(replay.stopReason, "toolUse", replay.errorMessage);
      assert.equal(requestCount, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
