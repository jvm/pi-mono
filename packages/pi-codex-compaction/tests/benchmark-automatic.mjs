/**
 * Explicitly authorized live subscription comparison. Never run in npm test.
 * PI_LIVE_COMPACTION=1 node --import tsx packages/pi-codex-compaction/tests/benchmark-automatic.mjs
 * Synthetic text only; stdout contains metrics, never credentials/checkpoints.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";

if (process.env.PI_LIVE_COMPACTION !== "1") throw new Error("Explicit PI_LIVE_COMPACTION=1 consent required");
process.env.PI_OFFLINE = "1"; // Disable package telemetry, not explicitly authorized inference.
const dir = await mkdtemp(join(tmpdir(), "pi-compaction-benchmark-"));
const fetchOriginal = globalThis.fetch;
const metrics = [];
const requestStarts = new Map();
let requests = 0;
let inputBudget = process.argv.includes("--probe") ? 30_000 : 150_000;
let mode;
const probe = process.argv.includes("--probe");
const shapes = [];
globalThis.fetch = async (url, init) => {
  const target = new URL(typeof url === "string" ? url : url instanceof URL ? url : url.url);
  if (target.origin !== "https://api.openai.com" || target.pathname !== "/v1/responses") {
    throw new Error("Benchmark blocks non-Responses traffic, including credential refresh");
  }
  const body = JSON.parse(init.body);
  // UTF-8 bytes are a conservative text-token preflight bound, not reported usage.
  const budget = Buffer.byteLength(JSON.stringify(body));
  if (++requests > (probe ? 2 : 8) || budget > inputBudget) throw new Error("Benchmark usage ceiling reached");
  inputBudget -= budget;
  metrics.push({ mode, request: requests, requestBytes: budget,
    automatic: !!body.context_management, sentCheckpoint: body.input.some((i) => i.type === "compaction") });
  requestStarts.set(requests, performance.now());
  return fetchOriginal(url, { ...init, redirect: "error", signal: AbortSignal.any([
    ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(180_000),
  ]) });
};

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let session;
try {
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStorePath: join(dir, "models.json") });
  assert.equal(runtime.isUsingOAuth("openai"), true, "An existing OpenAI ChatGPT subscription credential is required");
  const model = runtime.getModel("openai", "gpt-6-astra");
  assert.ok(model);
  const results = [];
  for (mode of (probe ? ["automatic"] : ["automatic", "standard"])) {
    const manager = SessionManager.inMemory(dir);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 1 },
      retry: { enabled: false }, cacheWarming: "off",
    });
    const errors = [];
    let localCompactions = 0;
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => "Answer in one short sentence. Keep the exact requested facts.",
      extensionFactories: [...(mode === "automatic" ? [extension] : []), (pi) => {
        pi.on("session_before_compact", () => { localCompactions++; });
        pi.on("provider_stream_event", (event) => {
          const data = event.data;
          const metric = metrics.at(-1);
          const start = metric && requestStarts.get(metric.request);
          if (metric && start !== undefined) {
            const elapsed = Math.round(performance.now() - start);
            if (data?.type === "response.output_text.delta" && data.delta?.length > 0) {
              metric.firstTextDeltaMs ??= elapsed;
              metric.maxTextDeltaGapMs = Math.max(metric.maxTextDeltaGapMs ?? 0,
                metric.lastTextDeltaMs === undefined ? 0 : elapsed - metric.lastTextDeltaMs);
              metric.lastTextDeltaMs = elapsed;
            }
            if (data?.type === "response.output_item.done" && data.item?.type === "compaction") {
              (metric.checkpointDoneMs ??= []).push(elapsed);
            }
            if (data?.type === "response.completed") metric.responseCompletedMs = elapsed;
          }
          if (data?.type === "response.output_item.done") shapes.push({
            request: requests, type: data.item?.type, outputIndex: data.output_index,
            keys: Object.keys(data.item ?? {}), idPresent: typeof data.item?.id === "string",
          });
          if (data?.type === "response.completed") shapes.push({
            request: requests, terminal: true, status: data.response?.status,
            outputTypes: data.response?.output?.map((item) => item.type),
          });
        });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime,
      sessionManager: manager, settingsManager: settings, resourceLoader: loader, thinkingLevel: "low", tools: [] }));
    await session.bindExtensions({ mode: "print", onError: () => errors.push("extension-error") });
    if (mode === "automatic") await session.prompt("/server-compaction on 1000");
    const history = [
      { role: "user", content: "Project ORCHID: release port is 4317; rollback switch is SAFE_MODE; never rename the ledger table.\n" +
        Array.from({ length: 90 }, (_, i) => `Audit ${i}: checked the synthetic request log; no defect. Preserve the release facts above.`).join("\n"), timestamp: 1 },
      { role: "assistant", provider: model.provider, api: model.api, model: model.id,
        content: [{ type: "text", text: "I will preserve the ORCHID release facts." }],
        usage: zeroUsage, stopReason: "stop", timestamp: 2 },
      { role: "user", content: "We are ready to release. Keep the earlier release constraints.", timestamp: 3 },
      { role: "assistant", provider: model.provider, api: model.api, model: model.id,
        content: [{ type: "text", text: "Ready." }], usage: zeroUsage, stopReason: "stop", timestamp: 4 },
    ];
    for (const message of history) manager.appendMessage(message);
    const started = performance.now();
    let compactMs;
    if (mode === "standard") {
      await session.compact();
      compactMs = Math.round(performance.now() - started);
    }
    await session.prompt("Name the project, release port, rollback switch, and forbidden schema change.", { expandPromptTemplates: false });
    const firstMs = Math.round(performance.now() - started);
    const checkpoints = manager.getBranch().filter((e) => e.type === "compaction");
    const answer = session.messages.filter((m) => m.role === "assistant").at(-1);
    if (!answer || answer.stopReason === "error" || answer.stopReason === "aborted") {
      results.push({ mode, outcome: "provider-error", requests, firstMs });
      console.log(JSON.stringify({ results, metrics, note: "Stopped; no retry or credential fallback." }, null, 2));
      process.exitCode = 1;
      break;
    }
    const hasCheckpoint = checkpoints.some((e) => e.details?.kind === "pi-codex-compaction:automatic:v1");
    const text = JSON.stringify(answer.content);
    const recall = ["ORCHID", "4317", "SAFE_MODE", "ledger"].every((fact) => text.includes(fact));
    const continueStart = performance.now();
    await session.prompt("Repeat only the port and rollback switch.");
    const last = session.messages.filter((m) => m.role === "assistant").at(-1);
    const continued = last && !["error", "aborted"].includes(last.stopReason);
    const continuationText = JSON.stringify(last?.content ?? []);
    const continuationRecall = continuationText.includes("4317") && continuationText.includes("SAFE_MODE");
    const sentCheckpoint = metrics.filter((entry) => entry.mode === mode).some((entry) => entry.sentCheckpoint);
    results.push({ mode, model: model.id, firstMs, compactMs,
      continuationMs: Math.round(performance.now() - continueStart), adoptedCheckpoint: hasCheckpoint,
      recall, continuationRecall,
      stats: session.getSessionStats().tokens, errors: errors.length, localCompactions });
    if (!continued || !recall || !continuationRecall || errors.length ||
        (mode === "automatic" && (!hasCheckpoint || !sentCheckpoint))) {
      console.log(JSON.stringify({ results, metrics, shapes, note: "Acceptance failed; no automatic retries." }, null, 2));
      process.exitCode = 1;
      break;
    }
    session.dispose();
    session = undefined;
  }
  if (!process.exitCode) console.log(JSON.stringify({ results, metrics, shapes,
    note: `${probe ? "Two-request automatic verification" : "One small comparison"}; subscription tokens, not dollar billing. No statistical latency claim.` }, null, 2));
} catch {
  // Provider errors can contain raw request details. Do not print them.
  console.log(JSON.stringify({ outcome: "blocked-or-failed", requests, metrics,
    note: "No credential fallback; inspect prerequisites without printing provider errors." }, null, 2));
  process.exitCode = 1;
} finally {
  session?.dispose();
  globalThis.fetch = fetchOriginal;
  await rm(dir, { recursive: true, force: true });
}
