import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ENDPOINT, reserveRequest, readEvents, functionTool, rawTool, namespace, inline,
  developer, user, stableNotes, toolOutputs, fingerprint } from "./support.mjs";

assert.equal(process.env.PI_LIVE_COMPACTION, "1", "Explicit live consent required");
assert.ok(process.env.PI_COMPACTION_HOST_ENTRY && process.env.PI_COMPACTION_LEDGER);
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const { ModelRuntime, ModelRegistry } = await import(pathToFileURL(process.env.PI_COMPACTION_HOST_ENTRY).href);
const dir = await mkdtemp(join(tmpdir(), "pi-cache-compact-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Non-experiment traffic, including refresh, blocked"); };
const metrics = [];
let phase = "setup";
try {
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStorePath: join(dir, "models.json") });
  assert.equal(runtime.isUsingOAuth("openai"), true);
  const model = runtime.getModel("openai", process.env.PI_EXPERIMENT_MODEL ?? "gpt-6-astra");
  const auth = await new ModelRegistry(runtime).getApiKeyAndHeaders(model);
  assert.ok(auth.ok && auth.apiKey);
  const arms = (process.env.PI_EXPERIMENT_ARMS ?? "inline,namespace,dual,hybrid").split(",");
  for (const arm of arms) {
    assert.ok(["inline", "namespace", "dual", "hybrid", "sticky"].includes(arm));
    let current = [functionTool("fixture"), rawTool];
    let base = structuredClone(current);
    const affinity = process.env.PI_CACHE_AFFINITY === "1" ? randomUUID() : undefined;
    const staticPrefix = process.env.PI_CACHE_STATIC_PREFIX === "1";
    const leading = developer("Synthetic cache experiment. Use the requested harmless tool exactly once with the requested input. Never simulate a tool call in text." +
      (staticPrefix ? "\n" + stableNotes(`static-${arm}-${model.id}`, 160) : ""));
    let history = [leading, ...(arm === "inline" || arm === "dual" ? [inline(base)] : []),
      user(staticPrefix ? "ORCHID port 4317; rollback SAFE_MODE." : stableNotes(`${arm}-${model.id}`, 160))];
    let previousInput;
    let previousTools;
    let previousOutput;
    const extended = process.env.PI_CACHE_EXTENDED === "1";
    for (let step = 0; step < (extended ? 12 : 7); step++) {
      const expected = step >= 2 && step <= 5 || step === 8 || step === 9 ? "late_fixture"
        : step === 6 || step === 11 ? "raw_fixture" : "fixture";
      const expectedValue = step >= 3 && expected === "late_fixture" || step >= 7 && expected === "fixture" ? "IRIS" : "ORCHID";
      if (step === 2 || step === 3) {
        const tool = functionTool("late_fixture", step === 2 ? 1 : 2);
        current = [...current.filter(t => t.name !== tool.name), tool];
        if (arm !== "namespace") history.push(inline([tool]));
      }
      if (step === 7) {
        const tool = functionTool("fixture", 2);
        current = current.map(t => t.name === tool.name ? tool : t);
        if (arm !== "namespace") history.push(inline([tool]));
        if (arm === "hybrid" || arm === "sticky") base = structuredClone(current);
      }
      if (step === 10) {
        current = current.filter(t => t.name !== "late_fixture");
        if (arm !== "namespace") history.push(developer("late_fixture is no longer available. Do not call it."));
        if (base.some(t => t.name === "late_fixture")) base = structuredClone(current);
      }
      const padding = step === 4 || step === 8 ? stableNotes(`compaction-boundary-${step}`, 250) + "\n" : "";
      history.push(user(padding + (expected === "raw_fixture" ? "Call raw_fixture with PING now."
        : `Call ${expected} with value ${expectedValue} now.`)));
      const top = arm === "inline" ? [] : [namespace(arm === "hybrid" || arm === "sticky" ? base : current)];
      const body = { model: model.id, store: false, stream: true, input: history,
        ...(top.length ? { tools: top } : {}), reasoning: { effort: "low", summary: "auto" },
        include: ["reasoning.encrypted_content"], ...(affinity ? { prompt_cache_key: affinity } : {}),
        context_management: [{ type: "compaction", compact_threshold: 8000 }] };
      const serialized = JSON.stringify(body);
      const request = await reserveRequest(process.env.PI_COMPACTION_LEDGER, Buffer.byteLength(serialized));
      phase = `${arm}:${step}`;
      const start = performance.now();
      const response = await originalFetch(ENDPOINT, { method: "POST", redirect: "error",
        headers: { ...auth.headers, authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json",
          ...(affinity ? { session_id: affinity, "x-client-request-id": affinity } : {}) },
        body: serialized, signal: AbortSignal.timeout(90_000) });
      const result = await readEvents(response);
      const calls = result.output.filter(i => ["function_call", "custom_tool_call"].includes(i.type));
      const passed = calls.length === 1 && calls[0].name === expected &&
        (expected === "raw_fixture" ? calls[0].input === "PING"
          : JSON.parse(calls[0].arguments).value === expectedValue);
      const prefixRetained = previousInput === undefined ? undefined
        : fingerprint(history.slice(0, previousInput.length)) === fingerprint(previousInput);
      const m = { arm, model: model.id, step, request, passed, ...result.usage,
        ms: Math.round(performance.now() - start), bytes: Buffer.byteLength(serialized),
        checkpoints: result.output.filter(i => i.type === "compaction").length,
        checkpointInput: history.filter(i => i.type === "compaction").length,
        outputTypes: result.output.map(i => i.type),
        calls: calls.map(i => ({ name: i.name, namespace: i.namespace, type: i.type })),
        prefixRetained, toolListChanged: previousTools === undefined ? undefined : fingerprint(top) !== previousTools,
        priorOutputRetained: previousOutput === undefined ? undefined
          : previousOutput.every(i => history.some(j => fingerprint(i) === fingerprint(j))) };
      console.log(JSON.stringify(m));
      metrics.push(m);
      if (!passed) break; // No retry; eliminate this candidate.
      previousInput = structuredClone(history);
      previousTools = fingerprint(top);
      previousOutput = structuredClone(result.output);
      const lastCheckpoint = result.output.findLastIndex(i => i.type === "compaction");
      if (process.env.PI_CACHE_PRUNE === "1" && lastCheckpoint >= 0) {
        // Pi's compaction system checkpoint makes the current loadout the next
        // epoch's base. Preserve developer instructions, not old user history.
        if (arm === "hybrid") base = structuredClone(current);
        history = [leading, ...(arm === "inline" || arm === "dual" ? [inline(current)] : []),
          ...(arm === "sticky" ? [inline(current)] : []),
          ...result.output.slice(lastCheckpoint), ...toolOutputs(result.output)];
      } else history.push(...result.output, ...toolOutputs(result.output));
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
