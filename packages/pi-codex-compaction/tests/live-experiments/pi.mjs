import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { getCurrentSystemMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mirrorTools, hybridTools } from "./tool-mirror.ts";
import { reserveRequest, summarizeUsage, stableNotes, fingerprint } from "./support.mjs";
import { createFreeformInputSchema, createOpenAILarkSampling } from "../../../pi-codex-tools/src/grammar.ts";

const offline = process.argv.includes("--offline");
const extended = process.argv.includes("--extended");
const longOnly = process.argv.includes("--long-only");
assert.ok(!longOnly || extended);
assert.ok(offline || process.env.PI_LIVE_COMPACTION === "1");
const useBaseline = process.argv.includes("--baseline");
if (useBaseline) assert.ok(process.env.PI_COMPACTION_BASELINE_ENTRY);
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(process.env.PI_COMPACTION_HOST_ENTRY).href);
const dir = await mkdtemp(join(tmpdir(), "pi-tools-cache-"));
const originalFetch = globalThis.fetch;
const sessions = [];
const metrics = [];
const results = [];
const phaseRequests = new Map();
let phase = "setup";
let desired = { name: "fixture", args: { value: "ORCHID" } };
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url));
  assert.equal(target.origin, "https://api.openai.com");
  assert.equal(target.pathname, "/v1/responses");
  const count = (phaseRequests.get(phase) ?? 0) + 1;
  phaseRequests.set(phase, count);
  assert.ok(count <= 3 && metrics.length < 64, "Bounded experiment continuation; no tool-error loops");
  const request = offline ? metrics.length + 1 : await reserveRequest(process.env.PI_COMPACTION_LEDGER, Buffer.byteLength(init.body));
  const p = JSON.parse(init.body);
  const metric = { phase, request, bytes: Buffer.byteLength(init.body), automatic: !!p.context_management,
    checkpointInput: p.input.filter(i => i.type === "compaction").length,
    toolNames: p.tools?.flatMap(t => t.tools?.map(x => x.name) ?? [t.name]), inlineBatches: p.input.filter(i => i.type === "additional_tools").length,
    started: performance.now(), outputTypes: [] };
  metrics.push(metric);
  if (offline) {
    const item = desired.text ? { type: "message", id: `msg_${request}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: desired.text, annotations: [] }] } : desired.name === "raw_fixture"
      ? { type: "custom_tool_call", id: `ctc_${request}`, call_id: `call_${request}`, name: desired.name, input: "PING", status: "completed" }
      : { type: "function_call", id: `fc_${request}`, call_id: `call_${request}`, name: desired.name,
        arguments: JSON.stringify(desired.args), status: "completed" };
    const output = [...(p.context_management ? [{ type: "compaction", id: `cmp_${request}`, encrypted_content: "synthetic" }] : []), item];
    const events = [{ type: "response.created", response: { id: `resp_${request}`, status: "in_progress" } }];
    for (const [output_index, done] of output.entries()) {
      events.push({ type: "response.output_item.added", output_index, item: done });
      events.push({ type: "response.output_item.done", output_index, item: done });
    }
    events.push({ type: "response.completed", response: { id: `resp_${request}`, status: "completed", output: [],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
  return originalFetch(url, { ...init, redirect: "error", signal: AbortSignal.any([
    ...(init.signal ? [init.signal] : []), AbortSignal.timeout(90000),
  ]) });
};
try {
  const credentials = offline ? new InMemoryCredentialStore() : undefined;
  if (credentials) await credentials.modify("openai", async () => ({ type: "api_key", key: "offline-fixture" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(dir, "models.json") });
  if (!offline) assert.equal(runtime.isUsingOAuth("openai"), true);
  async function make(strategy, modelId = process.env.PI_EXPERIMENT_MODEL ?? "gpt-6-astra") {
    const manager = SessionManager.inMemory(dir);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", defaultTools: ["fixture", "raw_fixture"],
    });
    const h = { strategy, manager, calls: [], errors: [], names: undefined, api: undefined, revision: 1,
      lateRevision: 0, followup: false,
      active: ["fixture", "raw_fixture"] };
    function registerFixture(pi, name = "fixture", revision = 1) {
      pi.registerTool({
        name, label: name, description: `Synthetic fixture revision ${revision}`,
        parameters: { type: "object", properties: { value: { type: "string", enum: [revision === 1 ? "ORCHID" : "IRIS"] } },
          required: ["value"], additionalProperties: false },
        async execute(_id, args) {
          h.calls.push({ name, args, revision });
          if (offline && h.followup) desired = { name: "raw_fixture", args: { input: "PING" } };
          return { content: [{ type: "text", text: h.followup && name === "fixture"
            ? "Now call raw_fixture with PING. Do not answer instead."
            : `Synthetic fixture succeeded with value ${args.value}. Port 4317; SAFE_MODE.` }], details: undefined,
            terminate: !(h.followup && name === "fixture") };
        },
      });
    }
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
      additionalExtensionPaths: [useBaseline ? process.env.PI_COMPACTION_BASELINE_ENTRY
        : fileURLToPath(new URL("../../index.ts", import.meta.url))],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => "Synthetic protocol experiment. Call the requested harmless tool exactly once and follow its result.\n" +
        stableNotes(`Pi-${strategy}-${modelId}`, 160),
      extensionFactories: [pi => {
        h.api = pi;
        registerFixture(pi, "fixture", h.revision);
        if (h.lateRevision) registerFixture(pi, "late_fixture", h.lateRevision);
        pi.on("session_start", () => pi.setActiveTools(h.active));
        pi.registerTool({
          name: "raw_fixture", label: "Raw", description: "Synthetic grammar fixture.",
          parameters: createFreeformInputSchema("input", "Synthetic input"),
          constrainedSampling: createOpenAILarkSampling('start: "PING"'),
          async execute(_id, args) {
            h.calls.push({ name: "raw_fixture", args });
            return { content: [{ type: "text", text: "PONG" }], details: undefined, terminate: true };
          },
        });
        pi.registerTool({
          name: "controller", label: "Controller", description: "Harmless orchestrator; calls fixture internally.",
          exposure: "model-only",
          prepareLoadout: loadout => ({ hiddenDeclarations: loadout.declared.filter(t => t.name !== "controller").map(t => t.name) }),
          parameters: { type: "object", properties: { value: { type: "string", enum: ["IRIS"] } }, required: ["value"] },
          async execute(_id, args, _signal, _update, ctx) {
            const result = await ctx.executeTool("fixture", args);
            h.calls.push({ name: "controller", args });
            return { content: result.content, details: undefined, terminate: true };
          },
        });
        pi.registerCommand("experiment-add", { description: "Add synthetic tool", handler: async () => {
          h.lateRevision = 1;
          registerFixture(pi, "late_fixture");
          pi.setActiveTools([...new Set([...pi.getActiveTools(), "late_fixture"])]);
          h.active = pi.getActiveTools();
        } });
        pi.registerCommand("experiment-update-late", { description: "Change inline-only schema", handler: async () => {
          h.lateRevision = 2;
          registerFixture(pi, "late_fixture", 2);
          pi.setActiveTools([...new Set([...pi.getActiveTools(), "late_fixture"])]);
          h.active = pi.getActiveTools();
        } });
        pi.registerCommand("experiment-redefine", { description: "Replace synthetic schema", handler: async () => {
          registerFixture(pi, "fixture", 2);
          h.revision = 2;
          h.active = ["fixture", "late_fixture"];
          pi.setActiveTools(h.active);
        } });
        pi.on("context_with_system", event => {
          h.names = getCurrentSystemMessage(event.messages)?.toolsAdded?.map(t => t.name) ?? [];
        });
        if (useBaseline) pi.on("before_provider_request", (event, ctx) => {
          const branch = ctx.sessionManager.getBranch();
          const config = branch.filter(e => e.type === "custom" && e.customType === "pi-codex-compaction:automatic:v1:config").at(-1)?.data;
          if (config?.enabled === false && !branch.some(e => e.type === "compaction")) return;
          const before = fingerprint(event.payload.input);
          const adapted = strategy === "hybrid" ? hybridTools(event.payload, h.names) : mirrorTools(event.payload, h.names);
          if (!adapted) console.log(JSON.stringify({ mappingFailure: true, phase, names: h.names,
            active: pi.getActiveTools(), inline: event.payload.input.filter(i => i.type === "additional_tools").map(i =>
              i.tools.map(tool => ({ type: tool.type, name: tool.name }))), top: event.payload.tools?.map(t => t.name) }));
          assert.ok(adapted, "No ambiguous or missing native tool state is allowed");
          assert.equal(fingerprint(adapted.input), before, "Never rewrite native inline or system history");
          return adapted;
        });
        pi.on("provider_stream_event", event => {
          const metric = metrics.at(-1);
          if (event.data?.type === "response.output_item.done") metric.outputTypes.push(event.data.item.type);
          if (event.data?.type === "response.completed") {
            Object.assign(metric, summarizeUsage(event.data.response.usage));
            metric.ms = Math.round(performance.now() - metric.started);
            delete metric.started;
            console.log(JSON.stringify(metric));
          }
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("openai", modelId),
      settingsManager, sessionManager: manager, resourceLoader: loader, thinkingLevel: "low",
    });
    sessions.push(session);
    h.session = session;
    await session.bindExtensions({ mode: "print", onError: e => h.errors.push({ event: e.event }) });
    await session.prompt("/server-compaction on 1000");
    return h;
  }
  async function run(h, label, name = "fixture", value = h.revision === 1 ? "ORCHID" : "IRIS", prefix = "") {
    phase = `${h.strategy}:${label}`;
    desired = { name, args: name === "raw_fixture" ? { input: "PING" } : { value } };
    const count = h.calls.length;
    await h.session.prompt(prefix + `Execution request ${label}. Make a new actual tool call; earlier results do not satisfy this request.\n` +
      (name === "raw_fixture" ? "Call raw_fixture with PING now."
      : `Call ${name} with value ${value} now. Use the actual declared tool.`));
    const last = h.session.messages.filter(m => m.role === "assistant").at(-1);
    assert.ok(last && !["error", "aborted"].includes(last.stopReason), "Provider failed; no retry");
    assert.deepEqual(h.errors, []);
    const calls = h.calls.slice(count);
    const passed = calls.some(c => c.name === name && (name === "raw_fixture" ? c.args.input === "PING" : c.args.value === value));
    const answer = last.content.filter(c => c.type === "text").map(c => c.text).join("");
    const result = { phase, passed, executions: calls.map(c => c.name),
      ...(!passed ? { reportedUnavailable: /unavailable|not available|no .*tools|cannot.*tool|can't.*tool/i.test(answer),
        reportedAlreadyDone: /already|previous|earlier/i.test(answer) } : {}),
      checkpoints: h.manager.getBranch().filter(e => e.type === "compaction").length };
    results.push(result);
    console.log(JSON.stringify(result));
    return passed;
  }
  const strategy = useBaseline ? process.env.PI_EXPERIMENT_STRATEGY ?? "hybrid" : "automatic";
  const h = await make(strategy);
  if (!longOnly) {
  assert.equal(await run(h, "initial"), true);
  await h.session.prompt("/experiment-add");
  assert.equal(await run(h, "late-addition-during-compaction", "late_fixture", "ORCHID"), true);
  await h.session.prompt("/experiment-redefine");
  assert.equal(await run(h, "base-schema-and-removal"), true);
  await h.session.prompt("/server-compaction off");
  await h.session.reload();
  assert.equal(await run(h, "off-and-reload"), true);
  const firstCheckpoint = h.manager.getBranch().find(e => e.type === "compaction");
  await h.session.navigateTree(firstCheckpoint.id, { summarize: false });
  assert.equal(await run(h, "checkpoint-branch"), true);
  h.api.setActiveTools(["controller", "fixture", "raw_fixture"]);
  h.active = ["controller", "fixture", "raw_fixture"];
  assert.equal(await run(h, "hidden-loadout", "controller", "IRIS"), true);
  assert.deepEqual(metrics.at(-1).toolNames, ["controller"]);
  const sol = await make(strategy, "gpt-6-sol");
  assert.equal(await run(sol, "sol-initial"), true);
  await sol.session.prompt("/experiment-add");
  assert.equal(await run(sol, "sol-late-addition", "late_fixture", "ORCHID"), true);
  let remaining = offline ? 3 : 72 - JSON.parse(await readFile(process.env.PI_COMPACTION_LEDGER, "utf8")).requests;
  if (remaining >= 2) {
    h.api.setActiveTools(["fixture", "raw_fixture"]);
    h.followup = true;
    assert.equal(await run(h, "two-step-continuation"), true);
    assert.deepEqual(h.calls.slice(-2).map(c => c.name), ["fixture", "raw_fixture"]);
    remaining -= 2;
  }
  if (remaining >= 1) {
    const disabled = await make(strategy);
    await disabled.session.prompt("/server-compaction off");
    assert.equal(await run(disabled, "fresh-disabled"), true);
    assert.equal(metrics.at(-1).automatic, false);
    assert.equal(metrics.at(-1).toolNames, undefined);
  }
  } else {
    await h.session.prompt("/experiment-redefine");
  }
  if (extended) {
    h.followup = false;
    h.active = ["fixture", "raw_fixture"];
    h.api.setActiveTools(h.active);
    await h.session.prompt("/server-compaction on 8000");
    const sentinel = "SYNTHETIC_LARCH_73";
    const checkpointsBefore = h.manager.getBranch().filter(e => e.type === "compaction").length;
    assert.equal(await run(h, "long-session:fact", "fixture", "IRIS",
      `Remember the user's audit sentinel ${sentinel} for the end-of-session recall check. This is synthetic data.\n`), true);
    assert.equal(await run(h, "long-session:steady"), true);
    await h.session.prompt("/experiment-add");
    assert.equal(await run(h, "long-session:add", "late_fixture", "ORCHID"), true);
    await h.session.prompt("/experiment-update-late");
    assert.equal(await run(h, "long-session:inline-schema", "late_fixture", "IRIS"), true);
    assert.equal(await run(h, "long-session:boundary-one", "late_fixture", "IRIS",
      stableNotes("long-session-first-window", 650) + "\n"), true);
    assert.equal(await run(h, "long-session:after-boundary", "late_fixture", "IRIS"), true);
    assert.equal(await run(h, "long-session:boundary-two", "raw_fixture", undefined,
      stableNotes("long-session-second-window", 650) + "\n"), true);
    h.active = h.api.getActiveTools();
    await h.session.reload();
    assert.equal(await run(h, "long-session:reload", "late_fixture", "IRIS"), true);
    phase = `${strategy}:long-session:recall`;
    desired = { text: sentinel };
    await h.session.prompt("Do not call a tool. Return only the user's audit sentinel from earlier in this session.");
    const last = h.session.messages.filter(m => m.role === "assistant").at(-1);
    assert.ok(last && last.stopReason === "stop");
    const answer = last.content.filter(c => c.type === "text").map(c => c.text).join("");
    assert.ok(answer.includes(sentinel), "User-only fact must survive multiple compactions and reload");
    const checkpoints = h.manager.getBranch().filter(e => e.type === "compaction").length;
    assert.ok(checkpoints >= checkpointsBefore + 2);
    results.push({ phase, passed: true, checkpoints, recall: true });
    console.log(JSON.stringify(results.at(-1)));
    assert.deepEqual(h.errors, []);
  }
  console.log(JSON.stringify({ done: true, recommendedCandidate: strategy, results, metrics }));
} catch (e) {
  console.log(JSON.stringify({ failed: true, phase, error: e.name,
    check: e.code === "ERR_ASSERTION" ? e.message.slice(0, 200) : "Raw error withheld", results, metrics }));
  process.exitCode = 1;
} finally {
  for (const session of sessions) session.dispose();
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
