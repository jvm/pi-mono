import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { codexHarness } from "../../../tests/codex-harness.mjs";
import reasoning from "../extensions/index.ts";
import compaction from "../../pi-codex-compaction/extensions/index.ts";
import fast from "../../pi-fast/extensions/index.ts";
import tools from "../../pi-codex-tools/extensions/index.ts";

if (process.env.PI_CODEX_LIVE_SMOKE !== "1") {
  console.error("Set PI_CODEX_LIVE_SMOKE=1 to use subscription usage. No requests sent.");
  process.exit(1);
}
process.env.PI_TELEMETRY = "0";
const modelRuntime = await ModelRuntime.create({ modelsPath: null, signal: AbortSignal.timeout(30_000) });
assert.ok(modelRuntime.isUsingOAuth("openai-codex"), "Existing Pi Codex OAuth is required");
const requests = [];
const observe = (pi) => pi.on("before_provider_request", (event) => {
  const body = event.payload;
  // Record shape only, never prompt text, tokens or opaque response contents.
  requests.push({
    effort: body.reasoning?.effort,
    updates: body.input.filter((i) => i.type === "configuration_update").map((i) => i.reasoning.effort),
    checkpoint: body.input.some((i) => i.type === "compaction"),
    fast: body.service_tier === "priority",
    grammar: body.tools?.find((t) => t.name === "apply_patch")?.type === "custom",
  });
});
const h = await codexHarness([reasoning, compaction, fast, tools, observe], { modelRuntime });
let timer;
async function bounded(run) {
  let expired = false;
  timer = setTimeout(() => {
    expired = true;
    h.session.abortCompaction();
    void h.session.abort();
  }, 60_000);
  try {
    const result = await run();
    assert.equal(expired, false, "Smoke deadline exceeded");
    return result;
  } finally { clearTimeout(timer); }
}
async function prompt(text) {
  await bounded(() => h.session.prompt(text));
  assert.equal(h.session.messages.at(-1).stopReason, "stop", "Codex request failed");
}
try {
  h.session.setActiveToolsByName(["apply_patch"]);
  // Keep the real grammar schema on the wire, but disallow filesystem execution.
  h.api.on("before_provider_request", (event) => ({ ...event.payload, tool_choice: "none" }));
  await h.session.prompt("/fast off");
  await prompt("This is a short protocol test. Remember the word ORBIT. Reply only OK. Do not use tools.");
  h.session.setThinkingLevel("medium");
  await prompt("Reply only OK. Do not use tools.");
  assert.equal(requests[0].effort, "low");
  assert.equal(requests[1].effort, "low");
  assert.deepEqual(requests[1].updates, ["medium"]);
  await h.session.prompt("/fast on");
  await prompt("Reply only OK. Do not use tools.");
  assert.equal(requests.at(-1).fast, true);
  assert.equal(requests.at(-1).grammar, true);
  const checkpoint = await bounded(() => h.session.compact());
  assert.equal(checkpoint.details?.kind, "pi-codex-compaction", "Remote compaction fell back");
  assert.ok(checkpoint.usage?.totalTokens > 0, "Compaction usage missing");
  await prompt("What word did I ask you to remember? Reply with that word only. Do not use tools.");
  assert.ok(h.session.messages.at(-1).content.some((c) => c.type === "text" && c.text.includes("ORBIT")));
  assert.equal(requests.at(-1).checkpoint, true);
  assert.deepEqual(requests.at(-1).updates, ["medium"]);
  assert.equal(requests.at(-1).effort, "medium");
  assert.deepEqual(h.errors, []);
  console.log(JSON.stringify({
    passed: true, model: h.model.id, requests,
    compactionTokens: checkpoint.usage.totalTokens,
    totalTokens: h.session.getSessionStats().tokens,
  }));
} finally {
  clearTimeout(timer);
  await h.close();
}
