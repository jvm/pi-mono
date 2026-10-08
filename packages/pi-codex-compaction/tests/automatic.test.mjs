import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import fast from "../../pi-fast/extensions/index.ts";
import codexTools from "../../pi-codex-tools/extensions/index.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";
beforeEach((t) => t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network blocked"); }));
const kind = "pi-codex-compaction:automatic:v1";
const checkpoint = (id = "cmp_1") => ({ id, type: "compaction", encrypted_content: `opaque-${id}` });
const text = (id, value) => ({ type: "message", id, role: "assistant", status: "completed",
  content: [{ type: "output_text", text: value, annotations: [] }] });
const usage = { input_tokens: 900, output_tokens: 100, total_tokens: 1000,
  input_tokens_details: { cached_tokens: 200, cache_write_tokens: 50 },
  output_tokens_details: { reasoning_tokens: 30 } };

function response(output, { id = "resp_1", status = "completed", malformed = false, terminalOutput = [],
  usage: reportedUsage = usage } = {}) {
  const events = [{ type: "response.created", response: { id, status: "in_progress" } }];
  output.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index,
      item: item.type === "message" ? { ...item, content: [] } : item });
    events.push({ type: "response.output_item.done", output_index, item });
  });
  if (!malformed) events.push({ type: `response.${status}`, response: { id, status, output: terminalOutput, usage: reportedUsage } });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

async function harness({ factories = [], enabled = true, settings = {}, sessionManager, modelId = "gpt-6-astra",
  extensionLast = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-auto-compact-"));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-fixture-not-a-real-key" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(dir, "models.json") });
  const model = runtime.getModel("openai", modelId);
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 1 },
    retry: { enabled: false }, ...settings,
  });
  const manager = sessionManager ?? SessionManager.inMemory(dir);
  const errors = [];
  let api;
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "You are a test assistant.",
    extensionFactories: [...(extensionLast ? [...factories, extension] : [extension, ...factories]), (pi) => { api = pi; }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime,
    sessionManager: manager, settingsManager, resourceLoader: loader, thinkingLevel: "low" });
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  if (enabled) await session.prompt("/server-compaction on 1000");
  else if (enabled === false) await session.prompt("/server-compaction off");
  return { session, manager, api, errors, credentials, model, runtime,
    async close() { session.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

function mockResponses(t, outputs) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    requests.push(JSON.parse(init.body));
    assert.ok(outputs.length, "unexpected additional request");
    const next = outputs.shift();
    return next instanceof Response ? next : response(next, { id: `resp_${requests.length}` });
  });
  return requests;
}

test("real Pi enables public server compaction by default without a command or saved setting", async (t) => {
  const requests = mockResponses(t, [[checkpoint(), text("msg_1", "answer")], [text("msg_2", "next")]]);
  const h = await harness({ enabled: null });
  try {
    assert.equal(h.manager.getBranch().some((entry) => entry.customType === `${kind}:config`), false);
    await h.session.prompt("old");
    assert.deepEqual(requests[0].context_management, [{
      type: "compaction", compact_threshold: Math.floor((h.model.contextWindow - 8192) * 0.6),
    }]);
    await h.session.prompt("continue");
    assert.deepEqual(requests[1].input.find((item) => item.type === "compaction"), checkpoint());
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("real Pi adopts a mid-response checkpoint and replays its exact suffix without another request", async (t) => {
  const suffix = text("msg_after", "retained answer");
  const requests = mockResponses(t, [
    [text("msg_before", "already compacted"), checkpoint(), suffix],
    [text("msg_next", "next answer")],
  ]);
  const h = await harness();
  try {
    await h.session.prompt("old private fixture", { expandPromptTemplates: false });
    const entry = h.manager.getBranch().find((e) => e.type === "compaction");
    assert.equal(entry?.details.kind, kind);
    assert.equal(entry.usage, undefined, "ordinary response owns usage");
    assert.equal(requests.length, 1, "no separate compaction inference");
    assert.deepEqual(requests[0].context_management, [{ type: "compaction", compact_threshold: 1000 }]);
    assert.equal(requests[0].store, false);
    await h.session.prompt("continue");
    const input = requests[1].input;
    assert.equal(JSON.stringify(input).includes("old private fixture"), false);
    assert.equal(JSON.stringify(input).includes("already compacted"), false);
    assert.equal(input.filter((i) => i.id === suffix.id).length, 1);
    assert.deepEqual(input.find((i) => i.id === suffix.id), suffix);
    assert.deepEqual(input.find((i) => i.type === "compaction"), checkpoint());
    assert.equal(h.session.getSessionStats().tokens.total, 2000);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("real Pi tool continuation retains raw calls and tool results around the checkpoint", async (t) => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "fixture",
    arguments: '{"value":"ok"}', status: "completed" };
  const requests = mockResponses(t, [[checkpoint(), call], [text("msg_final", "done")]]);
  const h = await harness({ factories: [(pi) => pi.registerTool({
    name: "fixture", label: "Fixture", description: "Fixture tool",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    async execute(_id, args) { return { content: [{ type: "text", text: args.value }], details: undefined }; },
  })] });
  try {
    await h.session.prompt("use fixture");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.find((i) => i.type === "function_call"), call);
    assert.equal(requests[1].input.find((i) => i.type === "function_call_output").output, "ok");
    assert.equal(requests[1].input.filter((i) => i.type === "compaction").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("last checkpoint wins, including a checkpoint after all assistant output", async (t) => {
  const requests = mockResponses(t, [
    [checkpoint("cmp_old"), text("msg_between", "between"), checkpoint("cmp_last")],
    [text("msg_next", "continued")],
  ]);
  const h = await harness();
  try {
    await h.session.prompt("old");
    await h.session.prompt("new");
    assert.deepEqual(requests[1].input.filter((i) => i.type === "compaction"), [checkpoint("cmp_last")]);
    assert.equal(JSON.stringify(requests[1].input).includes("between"), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const variant of ["disabled", "incomplete", "malformed", "oversized", "unknown-output"]) {
  test(`does not discard history on ${variant}`, async (t) => {
    const items = [checkpoint(), text("msg_1", "answer")];
    if (variant === "oversized") items[0].encrypted_content = "x".repeat(2_000_001);
    if (variant === "unknown-output") items.push({ type: "unknown_future_item", id: "x" });
    const requests = mockResponses(t, [response(items, {
      status: variant === "incomplete" ? "incomplete" : "completed",
      malformed: variant === "malformed",
    })]);
    const h = await harness({ enabled: variant !== "disabled" });
    try {
      await h.session.prompt("preserve me");
      assert.equal(h.manager.getBranch().some((e) => e.type === "compaction"), false);
      assert.ok(h.manager.buildSessionProjection().messages.some((m) => m.role === "user" && m.content === "preserve me" ||
        JSON.stringify(m.content).includes("preserve me")));
      assert.equal(requests.length, 1);
    } finally { await h.close(); }
  });
}

test("reload restores checkpoint replay even with automatic mode turned off", async (t) => {
  const requests = mockResponses(t, [[checkpoint(), text("msg_1", "answer")], [text("msg_2", "next")]]);
  const h = await harness();
  try {
    await h.session.prompt("old");
    await h.session.prompt("/server-compaction off");
    await h.session.reload();
    await h.session.prompt("new");
    assert.equal(requests[1].context_management, undefined);
    assert.equal(requests[1].input.filter((i) => i.type === "compaction").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("credential rotation uses readable fallback, never the old opaque checkpoint", async (t) => {
  const requests = mockResponses(t, [[checkpoint(), text("msg_1", "answer")], [text("msg_2", "next")]]);
  const h = await harness();
  try {
    await h.session.prompt("old");
    await h.runtime.setRuntimeApiKey("openai", "sk-other-fixture");
    await h.session.prompt("new");
    assert.equal(requests[1].input.some((i) => i.type === "compaction"), false);
    assert.match(JSON.stringify(requests[1].input), /bounded readable fallback/);
  } finally { await h.close(); }
});

test("context edits to the retained assistant prevent stale raw replay", async (t) => {
  const requests = mockResponses(t, [[checkpoint(), text("msg_1", "secret")], [text("msg_2", "next")]]);
  const h = await harness();
  try {
    await h.session.prompt("old");
    const entry = h.manager.getBranch().find((e) => e.type === "compaction");
    h.manager.appendContextEdit(entry.firstKeptEntryId, { content: [{ type: "text", text: "redacted" }] });
    await h.session.prompt("new");
    assert.equal(requests[1].input.some((i) => i.type === "compaction"), false);
    assert.equal(JSON.stringify(requests[1].input).includes("secret"), false);
  } finally { await h.close(); }
});

// Pi dispatches transforms by extension load order, not registration time.
// The documented contract requires this package after incompatible transforms.
for (const field of ["configuration_update", "previous_response_id", "truncation", "context_management"]) {
    test(`does not enable automatic compaction with ${field} from an earlier transformer`, async (t) => {
      const requests = mockResponses(t, [[text("msg_1", "answer")]]);
      const h = await harness({ extensionLast: true, factories: [(pi) => pi.on("before_provider_request", (event) => {
        const payload = event.payload;
        if (field === "configuration_update") payload.input.push({ type: field, reasoning: { effort: "low" } });
        else payload[field] = field === "context_management" ? [{ type: "compaction", compact_threshold: 5555 }] : "fixture";
      })] });
      try {
        await h.session.prompt("test");
        assert.deepEqual(requests[0].context_management, field === "context_management"
          ? [{ type: "compaction", compact_threshold: 5555 }] : undefined);
      } finally { await h.close(); }
    });
}

for (const mode of ["off", "on", "only"]) {
  test(`automatic requests preserve Pi's effective ${mode} codemode loadout and Fast`, async (t) => {
    const requests = mockResponses(t, [[checkpoint(), text("msg_1", "answer")], [text("msg_2", "next")]]);
    const h = await harness({ settings: {
      defaultTools: ["read", "bash", "edit", "write", ...(mode === "off" ? [] : ["codemode"])],
    }, factories: [fast, ...(mode === "off" ? [] : [createCodemodeExtension({ mode })]), codexTools] });
    try {
      await h.session.prompt("/fast on");
      await h.session.prompt("old");
      await h.session.prompt("new");
      assert.deepEqual(requests[1].tools, requests[0].tools);
      assert.equal(requests[1].service_tier, requests[0].service_tier);
      assert.ok(requests[1].service_tier);
      const wire = JSON.stringify(requests[0].tools);
      if (mode !== "off") assert.match(wire, /codemode/);
      if (mode === "only") assert.equal(requests[0].tools.some((tool) => tool.name === "read"), false);
      assert.equal(requests[1].input.some((i) => i.type === "compaction"), true);
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

test("repeated checkpoints replace the old window once and do not double-count usage", async (t) => {
  const requests = mockResponses(t, [
    [checkpoint("cmp_1"), text("msg_1", "one")],
    [text("msg_2", "two"), checkpoint("cmp_2")],
    [text("msg_3", "three")],
  ]);
  const h = await harness();
  try {
    await h.session.prompt("first");
    await h.session.prompt("second");
    await h.session.prompt("third");
    assert.deepEqual(requests[2].input.filter((i) => i.type === "compaction"), [checkpoint("cmp_2")]);
    assert.equal(JSON.stringify(requests[2].input).includes("opaque-cmp_1"), false);
    assert.equal(JSON.stringify(requests[2].input).includes('"two"'), false);
    assert.equal(h.session.getSessionStats().tokens.total, 3000);
  } finally { await h.close(); }
});

test("model switches do not replay an incompatible checkpoint", async (t) => {
  const requests = mockResponses(t, [[checkpoint(), text("msg_1", "one")], [text("msg_2", "two")]]);
  const h = await harness();
  try {
    await h.session.prompt("first");
    await h.session.setModel({ ...h.model, id: "gpt-5.6-sol" });
    await h.session.prompt("second");
    assert.equal(requests[1].input.some((i) => i.type === "compaction"), false);
    assert.match(JSON.stringify(requests[1].input), /bounded readable fallback/);
  } finally { await h.close(); }
});

test("a failed request pauses automatic mode but preserves history and does not add paid retries", async (t) => {
  const requests = mockResponses(t, [
    new Response(JSON.stringify({ error: { message: "fixture rejection", type: "invalid_request_error" } }), { status: 400 }),
    [text("msg_2", "two")],
  ]);
  const h = await harness();
  try {
    await h.session.prompt("first");
    assert.equal(requests.length, 1);
    await h.session.prompt("second");
    assert.equal(requests[1].context_management, undefined);
    assert.equal(h.manager.getBranch().some((e) => e.type === "compaction"), false);
  } finally { await h.close(); }
});

test("automatic compaction saves a separate inference compared with standard Pi compaction", async (t) => {
  const requests = mockResponses(t, [
    [checkpoint(), text("msg_auto", "ORCHID port 4317")],
    [text("msg_summary", "ORCHID uses port 4317.")],
    [text("msg_standard", "ORCHID port 4317")],
  ]);
  const automatic = await harness();
  const standard = await harness({ enabled: false });
  try {
    for (const h of [automatic, standard]) {
      h.manager.appendMessage({ role: "user", content: "ORCHID port 4317", timestamp: 1 });
      h.manager.appendMessage({ role: "user", content: "Keep the port.", timestamp: 2 });
    }
    await automatic.session.prompt("Which port?");
    assert.equal(requests.length, 1);
    await standard.session.compact();
    await standard.session.prompt("Which port?");
    assert.equal(requests.length, 3);
    assert.equal(requests[1].context_management, undefined);
    assert.equal(requests[2].context_management, undefined);
    assert.equal(automatic.session.getSessionStats().tokens.total, 1000);
    assert.equal(standard.session.getSessionStats().tokens.total, 2000);
    // Fixture usage tests accounting only; it is not a real cost/latency result.
  } finally { await automatic.close(); await standard.close(); }
});

for (const mode of ["on", "only"]) {
  for (const position of ["before", "after"]) {
    test(`raw codemode calls survive a checkpoint ${position} the call (${mode})`, async (t) => {
      const call = { type: "custom_tool_call", id: "ctc_code", call_id: "call_code",
        name: "codemode", input: 'text("safe fixture");', status: "completed" };
      const requests = mockResponses(t, [
        position === "before" ? [checkpoint(), call] : [call, checkpoint()],
        [text("msg_done", "done")],
      ]);
      const h = await harness({ settings: { defaultTools: ["read", "codemode"] },
        factories: [createCodemodeExtension({ mode })] });
      try {
        await h.session.prompt("Run the fixture");
        const next = requests[1].input;
        assert.equal(next.filter((i) => i.type === "compaction").length, 1);
        assert.equal(next.filter((i) => i.type === "custom_tool_call").length, position === "before" ? 1 : 0);
        assert.match(JSON.stringify(next.find((i) => i.type === "custom_tool_call_output")), /safe fixture/);
        assert.deepEqual(h.errors, []);
      } finally { await h.close(); }
    });
  }
}

test("branch navigation drops abandoned checkpoints and can restore the selected checkpoint", async (t) => {
  const requests = mockResponses(t, [
    [checkpoint(), text("msg_1", "one")], [text("msg_2", "two")], [text("msg_3", "three")],
  ]);
  const h = await harness();
  try {
    await h.session.prompt("first");
    const compact = h.manager.getBranch().find((e) => e.type === "compaction");
    const previous = h.manager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
    await h.session.navigateTree(previous.id, { summarize: false });
    await h.session.prompt("other branch");
    assert.equal(requests[1].input.some((i) => i.type === "compaction"), false);
    await h.session.navigateTree(compact.id, { summarize: false });
    await h.session.prompt("restored");
    assert.equal(requests[2].input.filter((i) => i.type === "compaction").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("late tool registration changes the current declaration without reintroducing old history", async (t) => {
  const requests = mockResponses(t, [[checkpoint(), text("msg_1", "one")], [text("msg_2", "two")]]);
  const h = await harness();
  try {
    await h.session.prompt("old");
    h.api.registerTool({ name: "late_fixture", label: "Late", description: "Late tool override",
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [], details: undefined }; } });
    await h.session.prompt("new");
    // Pi can carry a late declaration in an additional_tools input item.
    assert.match(JSON.stringify(requests[1]), /Late tool override/);
    assert.equal(requests[1].input.filter((i) => i.type === "compaction").length, 1);
  } finally { await h.close(); }
});

test("custom manual compaction still uses standard Pi without context_management", async (t) => {
  const requests = mockResponses(t, [[text("msg_summary", "focused summary")]]);
  const h = await harness();
  try {
    h.manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
    h.manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
    const result = await h.session.compact("Focus on release facts");
    assert.equal(result.summary.includes("focused summary"), true);
    assert.equal(requests[0].context_management, undefined);
    assert.match(JSON.stringify(requests[0]), /Focus on release facts/);
  } finally { await h.close(); }
});

test("invalid or too-late thresholds leave ordinary inference unchanged", async (t) => {
  const requests = mockResponses(t, [[text("msg_1", "one")], [text("msg_2", "two")]]);
  const h = await harness({ enabled: false });
  try {
    await h.session.prompt("/server-compaction on 999");
    await h.session.prompt("first");
    assert.equal(requests[0].context_management, undefined);
    await h.session.prompt("/server-compaction on 999999999");
    await h.session.prompt("second");
    assert.equal(requests[1].context_management, undefined);
  } finally { await h.close(); }
});

test("Pi's enabled threshold safety net still summarizes when the server returns no checkpoint", async (t) => {
  const h = await harness({ settings: { compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 1 } } });
  const requests = mockResponses(t, [
    response([text("msg_answer", "done")], { usage: { ...usage,
      input_tokens: h.model.contextWindow - 4096, total_tokens: h.model.contextWindow - 3996 } }),
    [text("msg_summary", "small summary")],
    [text("msg_prefix", "small turn prefix")],
  ]);
  try {
    h.manager.appendMessage({ role: "user", content: "old context ".repeat(3000), timestamp: 1 });
    h.manager.appendMessage({ role: "user", content: "recent", timestamp: 2 });
    h.session.agent.state.messages = h.manager.buildSessionProjection().messages;
    await h.session.prompt("continue");
    assert.equal(requests.length, 3, "ordinary inference plus Pi's two split-span summaries");
    assert.ok(requests[0].context_management);
    assert.equal(requests[1].context_management, undefined);
    assert.equal(requests[2].context_management, undefined);
    assert.ok(h.manager.getBranch().some((e) => e.type === "compaction" && e.details?.kind !== kind));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("an adopted checkpoint avoids Pi's compaction pause across a tool continuation with the safety net enabled", async (t) => {
  let localCompactions = 0;
  let toolExecutions = 0;
  const h = await harness({
    settings: { compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 1 } },
    factories: [(pi) => {
      pi.on("session_before_compact", () => { localCompactions++; });
      pi.registerTool({
        name: "flow_fixture", label: "Flow fixture", description: "Test uninterrupted tool continuation",
        parameters: { type: "object", properties: {} },
        async execute() {
          toolExecutions++;
          return { content: [{ type: "text", text: "tool finished" }], details: undefined };
        },
      });
    }],
  });
  const events = [];
  const unsubscribe = h.session.subscribe((event) => events.push(event.type));
  // Report pre-compaction usage above Pi's local threshold. It must not cause a
  // second compaction after the server checkpoint has replaced that context.
  const preCompactionUsage = { ...usage, input_tokens: h.model.contextWindow - 4096,
    total_tokens: h.model.contextWindow - 3996 };
  const call = { type: "function_call", id: "fc_flow", call_id: "call_flow",
    name: "flow_fixture", arguments: "{}", status: "completed" };
  const requests = mockResponses(t, [
    response([checkpoint(), call], { usage: preCompactionUsage }),
    [text("msg_final", "continued without a separate summary")],
    [text("msg_next", "next user turn")],
  ]);
  try {
    await h.session.prompt("/server-compaction on"); // Exercise the normal default, not the 1,000-token probe.
    await h.session.prompt("do the work");
    assert.equal(requests.length, 2, "only inference and its tool continuation");
    assert.equal(toolExecutions, 1);
    assert.deepEqual(requests[0].context_management, [{
      type: "compaction", compact_threshold: Math.floor((h.model.contextWindow - 8192) * 0.6),
    }]);
    assert.deepEqual(requests[1].input.find((item) => item.type === "compaction"), checkpoint());
    assert.equal(requests[1].input.find((item) => item.type === "function_call_output").output, "tool finished");
    await h.session.prompt("continue");
    assert.equal(requests.length, 3, "no extra pre-prompt or post-response summary");
    assert.equal(localCompactions, 0);
    assert.equal(events.includes("compaction_start"), false);
    assert.equal(h.session.autoCompactionEnabled, true, "the safety net was not disabled");
    assert.equal(h.session.getSessionStats().tokens.total, preCompactionUsage.total_tokens + 2000);
    assert.deepEqual(h.errors, []);
  } finally { unsubscribe(); await h.close(); }
});

test("text streams before response completion without waiting for turn-end adoption", async (t) => {
  let controller;
  let closed = false;
  let timeout;
  let markText;
  let markCheckpoint;
  const textSeen = new Promise((resolve) => { markText = resolve; });
  const checkpointSeen = new Promise((resolve) => { markCheckpoint = resolve; });
  const encoder = new TextEncoder();
  const send = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const body = new ReadableStream({ start(value) { controller = value; } });
  const requests = mockResponses(t, [
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    [text("msg_next", "next")],
  ]);
  const h = await harness({
    settings: { compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 1 } },
    factories: [(pi) => pi.on("provider_stream_event", (event) => {
      if (event.data?.type === "response.output_item.done" && event.data.item?.type === "compaction") markCheckpoint();
    })],
  });
  const events = [];
  const unsubscribe = h.session.subscribe((event) => {
    events.push(event.type);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") markText();
  });
  let running;
  try {
    send({ type: "response.created", response: { id: "resp_stream", status: "in_progress" } });
    send({ type: "response.output_item.added", output_index: 0,
      item: { ...text("msg_before", ""), content: [] } });
    send({ type: "response.content_part.added", output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } });
    send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Working." });
    send({ type: "response.output_item.done", output_index: 0, item: text("msg_before", "Working.") });
    send({ type: "response.output_item.done", output_index: 1, item: checkpoint() });
    running = h.session.prompt("old");
    await Promise.race([
      Promise.all([textSeen, checkpointSeen]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Text was not streamed")), 3000); }),
    ]);
    clearTimeout(timeout);
    assert.equal(requests.length, 1);
    assert.equal(h.manager.getBranch().some((entry) => entry.type === "compaction"), false,
      "checkpoint is not committed before the response succeeds");
    assert.equal(events.includes("compaction_start"), false);
    send({ type: "response.output_item.added", output_index: 2,
      item: { ...text("msg_after", ""), content: [] } });
    send({ type: "response.output_item.done", output_index: 2, item: text("msg_after", "Done.") });
    send({ type: "response.completed", response: { id: "resp_stream", status: "completed", output: [], usage } });
    controller.close();
    closed = true;
    await running;
    assert.equal(h.manager.getBranch().some((entry) => entry.type === "compaction" && entry.details?.kind === kind), true);
    await h.session.prompt("new");
    assert.deepEqual(requests[1].input.find((item) => item.type === "compaction"), checkpoint());
    assert.equal(requests[1].input.some((item) => item.id === "msg_before"), false);
    assert.equal(requests[1].input.find((item) => item.id === "msg_after").content[0].text, "Done.");
    assert.equal(events.includes("compaction_start"), false);
    assert.deepEqual(h.errors, []);
  } finally {
    clearTimeout(timeout);
    if (!closed) controller.error(new Error("Test stream cleanup"));
    await running?.catch(() => {});
    unsubscribe();
    await h.close();
  }
});

test("message_end redaction prevents adopting an unredacted raw suffix", async (t) => {
  mockResponses(t, [[checkpoint(), text("msg_secret", "sensitive answer")]]);
  const h = await harness({ extensionLast: true, factories: [(pi) => pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    return { message: { ...event.message, content: [{ type: "text", text: "redacted" }] } };
  })] });
  try {
    await h.session.prompt("old");
    assert.equal(h.manager.getBranch().some((e) => e.type === "compaction"), false);
    assert.doesNotMatch(JSON.stringify(h.manager.buildSessionProjection().messages), /sensitive answer/);
  } finally { await h.close(); }
});

test("cancellation after receiving a checkpoint does not commit it", async (t) => {
  mockResponses(t, [[checkpoint(), text("msg_1", "answer")]]);
  const h = await harness({ factories: [(pi) => pi.on("provider_stream_event", (event, ctx) => {
    if (event.data?.type === "response.output_item.done" && event.data.item?.type === "compaction") ctx.abort();
  })] });
  try {
    await h.session.prompt("preserve history");
    assert.equal(h.manager.getBranch().some((e) => e.type === "compaction"), false);
    assert.match(JSON.stringify(h.manager.buildSessionProjection().messages), /preserve history/);
  } finally { await h.close(); }
});

test("conflicting turn-end context edits take precedence over automatic adoption", async (t) => {
  mockResponses(t, [[checkpoint(), text("msg_1", "answer")]]);
  const h = await harness({ extensionLast: true, factories: [(pi) => pi.on("turn_end", (event) => ({
    entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }],
  }))] });
  try {
    await h.session.prompt("preserve history");
    assert.equal(h.manager.getBranch().some((e) => e.type === "compaction"), false);
  } finally { await h.close(); }
});

for (const fault of ["gap", "duplicate", "terminal-mismatch"]) {
  test(`stream ${fault} leaves the original history intact`, async (t) => {
    const cp = checkpoint();
    const done = { type: "response.output_item.done", output_index: fault === "gap" ? 1 : 0, item: cp };
    const events = [
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } }, done,
      ...(fault === "duplicate" ? [done] : []),
      { type: "response.completed", response: { id: "resp_1", status: "completed", usage,
        output: fault === "terminal-mismatch" ? [checkpoint("cmp_other")] : [] } },
    ];
    mockResponses(t, [new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } })]);
    const h = await harness();
    try {
      await h.session.prompt("old");
      assert.equal(h.manager.getBranch().some((e) => e.type === "compaction"), false);
    } finally { await h.close(); }
  });
}

test("uses the complete terminal array when a provider emits no done items", async (t) => {
  const cp = checkpoint();
  const requests = mockResponses(t, [
    response([], { terminalOutput: [cp] }), [text("msg_next", "next")],
  ]);
  const h = await harness();
  try {
    await h.session.prompt("old");
    assert.equal(h.manager.getBranch().some((e) => e.type === "compaction"), true);
    await h.session.prompt("new");
    assert.deepEqual(requests[1].input.find((i) => i.type === "compaction"), cp);
  } finally { await h.close(); }
});

for (const modelId of ["gpt-5.6-sol", "gpt-6-astra"]) {
  test(`preserves reasoning and message phases on ${modelId}`, async (t) => {
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning",
      summary: [{ type: "summary_text", text: "Thinking." }] };
    const message = { ...text("msg_answer", "answer"), phase: "final_answer" };
    const requests = mockResponses(t, [
      [checkpoint(), reasoning, message], [text("msg_next", "next")],
    ]);
    const h = await harness({ modelId });
    try {
      await h.session.prompt("old");
      await h.session.prompt("new");
      const input = requests[1].input;
      assert.deepEqual(input.find((i) => i.type === "compaction"), checkpoint());
      assert.deepEqual(input.find((i) => i.type === "reasoning"), reasoning);
      assert.deepEqual(input.find((i) => i.id === message.id), message);
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}
