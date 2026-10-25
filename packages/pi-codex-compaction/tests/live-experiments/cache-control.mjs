import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ENDPOINT, reserveRequest, readEvents, developer, user, stableNotes,
  namespace, functionTool, rawTool } from "./support.mjs";
assert.equal(process.env.PI_LIVE_COMPACTION, "1");
assert.ok(process.env.PI_COMPACTION_HOST_ENTRY && process.env.PI_COMPACTION_LEDGER,
  "Set PI_COMPACTION_HOST_ENTRY and PI_COMPACTION_LEDGER");
process.env.PI_OFFLINE = "1";
const { ModelRuntime, ModelRegistry } = await import(pathToFileURL(process.env.PI_COMPACTION_HOST_ENTRY).href);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Non-experiment traffic blocked"); };
const dir = await mkdtemp(join(tmpdir(), "pi-cache-control-"));
const metrics = [];
let phase = "setup";
try {
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStorePath: join(dir, "models.json") });
  assert.equal(runtime.isUsingOAuth("openai"), true);
  const model = runtime.getModel("openai", "gpt-6-astra");
  const auth = await new ModelRegistry(runtime).getApiKeyAndHeaders(model);
  assert.ok(auth.ok && auth.apiKey);
  for (const shape of ["implicit", "implicit-auto", "explicit-auto"]) {
    const id = randomUUID();
    const input = [developer("Synthetic cache control. Reply only READY; do not call tools."),
      user(stableNotes(`cache-control-${shape}`, 160) + "\nReply READY.")];
    if (shape === "explicit-auto") input[1].content[0].prompt_cache_breakpoint = { mode: "explicit" };
    const body = { model: model.id, store: false, stream: true, input, prompt_cache_key: id,
      tools: [namespace([functionTool("fixture"), rawTool])],
      reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"],
      ...(shape !== "implicit" ? { context_management: [{ type: "compaction", compact_threshold: 100000 }] } : {}),
      ...(shape === "explicit-auto" ? { prompt_cache_options: { mode: "explicit" } } : {}) };
    for (let repeat = 0; repeat < 2; repeat++) {
      phase = `${shape}:${repeat}`;
      const serialized = JSON.stringify(body);
      const request = await reserveRequest(process.env.PI_COMPACTION_LEDGER, Buffer.byteLength(serialized));
      const start = performance.now();
      const response = await originalFetch(ENDPOINT, { method: "POST", redirect: "error", body: serialized,
        signal: AbortSignal.timeout(90000),
        headers: { ...auth.headers, authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json",
          session_id: id, "x-client-request-id": id } });
      const result = await readEvents(response);
      const metric = { shape, repeat, request, ...result.usage, ms: Math.round(performance.now() - start),
        checkpoints: result.output.filter(i => i.type === "compaction").length };
      metrics.push(metric);
      console.log(JSON.stringify(metric));
    }
  }
  console.log(JSON.stringify({ done: true, metrics }));
} catch (e) {
  console.log(JSON.stringify({ failed: true, phase, error: e.name,
    check: e.code === "ERR_ASSERTION" ? e.message.slice(0, 200) : "Raw error withheld", metrics }));
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
