import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENDPOINT, reserveRequest, readEvents, functionTool, rawTool, namespace, inline,
  developer, user, stableNotes, toolOutputs, fingerprint } from "./support.mjs";

assert.equal(process.env.PI_LIVE_COMPACTION, "1", "Explicit live consent required");
assert.ok(process.env.PI_COMPACTION_HOST_ENTRY && process.env.PI_COMPACTION_LEDGER);
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const { ModelRuntime, ModelRegistry } = await import(pathToFileURL(process.env.PI_COMPACTION_HOST_ENTRY).href);
const dir = await mkdtemp(join(tmpdir(), "pi-raw-compact-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Non-experiment traffic, including credential refresh, blocked"); };
const results = [];
let phase = "setup";
try {
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStorePath: join(dir, "models.json") });
  assert.equal(runtime.isUsingOAuth("openai"), true, "No API-key fallback");
  const model = runtime.getModel("openai", "gpt-6-astra");
  assert.ok(model);
  const auth = await new ModelRegistry(runtime).getApiKeyAndHeaders(model);
  assert.ok(auth.ok && auth.apiKey);
  assert.ok(auth.baseUrl === undefined || auth.baseUrl === "https://api.openai.com/v1");
  async function send(input, tools, threshold, label, extra = {}) {
    phase = label;
    const body = { model: model.id, input, ...(tools?.length ? { tools } : {}), store: false, stream: true,
      reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"],
      ...(threshold ? { context_management: [{ type: "compaction", compact_threshold: threshold }] } : {}), ...extra };
    const serialized = JSON.stringify(body);
    const request = await reserveRequest(process.env.PI_COMPACTION_LEDGER, Buffer.byteLength(serialized));
    const start = performance.now();
    const response = await originalFetch(ENDPOINT, {
      method: "POST", headers: { ...auth.headers, authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
      body: serialized, signal: AbortSignal.timeout(90_000), redirect: "error",
    });
    const result = await readEvents(response);
    const calls = result.output.filter(i => ["function_call", "custom_tool_call"].includes(i.type));
    const metric = { label, request, bytes: Buffer.byteLength(serialized), threshold,
      ms: Math.round(performance.now() - start), ...result.usage,
      inlineCount: input.filter(i => i.type === "additional_tools").length,
      checkpointInput: input.filter(i => i.type === "compaction").length,
      checkpoints: result.output.filter(i => i.type === "compaction").length,
      calls: calls.map(i => ({ name: i.name, namespace: i.namespace, type: i.type })),
      toolFingerprint: fingerprint(tools ?? input.filter(i => i.type === "additional_tools")) };
    results.push(metric);
    console.log(JSON.stringify(metric));
    return { ...result, calls };
  }
  const tools = [functionTool("fixture"), rawTool];
  const instruction = developer("Synthetic protocol test. Call the requested harmless fixture exactly once. Do not simulate calls in text.");
  const prompt = user(stableNotes("raw-isolation", 95) + "\nCall fixture with value ORCHID now.");
  for (const shape of (process.env.PI_RAW_SHAPES ?? "inline-first,developer-first,namespace,inline-tail-copy").split(",")) {
    let input = shape === "inline-first" ? [inline(tools), instruction, prompt]
      : shape === "namespace" ? [instruction, prompt]
      : shape === "inline-tail-copy" ? [inline(tools), instruction, prompt, inline(tools)]
      : [instruction, inline(tools), prompt];
    const top = shape === "namespace" ? [namespace(tools)] : [];
    const first = await send(input, top, 1000, `${shape}:automatic-first`);
    assert.ok(first.output.some(i => i.type === "compaction"), "Isolation requires actual compaction");
    // Preserve EVERY original item and its position for the next raw request.
    if (first.calls.length) {
      input = [...input, ...first.output, ...toolOutputs(first.output), user("Call raw_fixture with PING now.")];
      const second = await send(input, top, 1000, `${shape}:append-only-grammar`);
      console.log(JSON.stringify({ shape, grammarPassed: second.calls[0]?.name === "raw_fixture" }));
    }
  }
  const controlInput = [inline(tools), instruction, prompt];
  const control = await send(controlInput, [], undefined, "inline-first:no-compaction-control");
  assert.equal(control.calls[0]?.name, "fixture");
  console.log(JSON.stringify({ done: true, results }));
} catch (e) {
  console.log(JSON.stringify({ failed: true, phase, error: e.name,
    check: e.code === "ERR_ASSERTION" ? e.message.slice(0, 200) : "Raw error withheld", results }));
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
