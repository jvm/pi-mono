import assert from "node:assert/strict";
import test from "node:test";
import { mirrorTools, hybridTools } from "./live-experiments/tool-mirror.ts";
import { functionTool, rawTool, inline, namespace } from "./live-experiments/support.mjs";

test("experimental mirror keeps all history, prompt deltas, results and cache fields byte-identical", () => {
  const payload = { model: "gpt-6-astra", prompt_cache_key: "synthetic", service_tier: "priority",
    input: [inline([functionTool("one"), rawTool]), { role: "developer", content: "A prompt update" },
      { type: "compaction", id: "cmp_fixture", encrypted_content: "synthetic" },
      { type: "custom_tool_call_output", call_id: "call_fixture", output: "PONG" }] };
  const original = JSON.stringify(payload);
  const result = mirrorTools(payload, ["one", "raw_fixture"]);
  assert.ok(result);
  assert.equal(result.input, payload.input);
  assert.equal(JSON.stringify(payload), original);
  assert.equal(result.prompt_cache_key, payload.prompt_cache_key);
  assert.equal(result.service_tier, payload.service_tier);
  assert.deepEqual(result.tools[0].tools, [functionTool("one"), rawTool]);
  assert.equal(result.tools[0].type, "namespace");
});

test("latest serialized schema wins, removed and hidden tools are absent from the mirror", () => {
  const payload = { input: [inline([functionTool("one"), functionTool("removed"), rawTool]),
    inline([functionTool("one", 2), functionTool("late")])] };
  const result = mirrorTools(payload, ["one", "late"]);
  assert.deepEqual(result.tools[0].tools, [functionTool("one", 2), functionTool("late")]);
  assert.equal(result.input, payload.input, "Do not rewrite the original inline history");
});

test("original namespace metadata and grammar formats survive unchanged", () => {
  const grouped = { ...namespace([rawTool]), name: "fixtures", description: "Custom namespace" };
  const result = mirrorTools({ input: [inline([grouped])] }, ["raw_fixture"]);
  assert.deepEqual(result.tools, [grouped]);
});

test("logical active tools hidden by the later host projection are never resurrected", () => {
  const result = mirrorTools({ input: [inline([functionTool("controller")])] }, ["controller", "hidden_fixture"]);
  assert.deepEqual(result.tools[0].tools.map(t => t.name), ["controller"]);
});

test("automatic base promotion removes only the leading declaration and preserves later inline changes", () => {
  const payload = { input: [inline([functionTool("base"), rawTool]), inline([functionTool("late")]),
    inline([functionTool("late", 2)])] };
  const result = hybridTools(payload, ["base", "raw_fixture", "late"]);
  assert.deepEqual(result.tools[0].tools, [functionTool("base"), rawTool]);
  assert.deepEqual(result.input, payload.input.slice(1));
  assert.equal(result.input[0], payload.input[1]);
  assert.equal(payload.input.length, 3, "Never mutate the original wire payload");
});

test("base promotion preserves developer messages and does not mutate leading namespace declarations", () => {
  const base = namespace([functionTool("base"), rawTool]);
  const initial = inline([base]);
  const message = { role: "developer", content: "Original instructions" };
  const later = inline([functionTool("late")]);
  const payload = { input: [message, initial, { role: "user", content: "Old question" }, later] };
  const before = structuredClone(payload);
  const result = hybridTools(payload, ["base", "raw_fixture", "late"]);
  assert.deepEqual(result.tools, [base]);
  assert.deepEqual(result.input, [message, payload.input[2], later]);
  assert.deepEqual(payload, before);
});

test("late first declarations retain their native position when the initial loadout was hidden", () => {
  const payload = { input: [{ role: "developer", content: "No initial tools" },
    { type: "compaction", id: "cmp_fixture", encrypted_content: "synthetic" }, inline([rawTool])] };
  const result = hybridTools(payload, ["raw_fixture", "hidden"]);
  assert.equal(result.input, payload.input);
  assert.deepEqual(result.tools[0].tools, [rawTool]);
});

test("schema object-key reordering does not invalidate a stable base", () => {
  const base = functionTool("base");
  const reordered = { strict: base.strict, parameters: { additionalProperties: false,
    required: ["value"], properties: base.parameters.properties, type: "object" },
    description: base.description, name: base.name, type: base.type };
  const payload = { input: [inline([base]), inline([reordered, functionTool("late")])] };
  const result = hybridTools(payload, ["base", "late"]);
  assert.deepEqual(result.tools[0].tools, [base], "Identical schemas must retain exact base bytes");
});

test("changed namespace metadata starts a current-state base instead of keeping stale instructions", () => {
  const first = { ...namespace([rawTool]), description: "Old namespace instructions" };
  const latest = { ...first, description: "New namespace instructions" };
  const payload = { input: [inline([first]), inline([latest, functionTool("late")])] };
  const result = hybridTools(payload, ["raw_fixture", "late"]);
  assert.equal(result.tools[0].description, latest.description);
  assert.ok(result.tools.some(group => group.tools.some(tool => tool.name === "late")));
});

for (const change of ["removed", "redefined", "checkpoint"]) {
  test(`hybrid starts a new current-state epoch when the base is ${change}`, () => {
    const payload = { input: change === "checkpoint" ? [inline([functionTool("late")])] :
      [inline([functionTool("base"), rawTool]), inline([functionTool("base", 2), functionTool("late")])] };
    const names = change === "removed" || change === "checkpoint" ? ["late"] : ["base", "raw_fixture", "late"];
    const result = hybridTools(payload, names);
    assert.deepEqual(result.tools, mirrorTools(payload, names).tools);
  });
}

for (const [label, payload, names] of [
  ["no effective loadout", { input: [inline([rawTool])] }, undefined],
  ["missing declaration", { input: [inline([rawTool])] }, ["missing"]],
  ["foreign top-level tools", { tools: [namespace([rawTool])], input: [inline([rawTool])] }, ["raw_fixture"]],
  ["duplicate loadout names", { input: [inline([rawTool])] }, ["raw_fixture", "raw_fixture"]],
  ["ambiguous namespaces", { input: [inline([rawTool, { ...namespace([rawTool]), name: "other" }])] }, ["raw_fixture"]],
  ["duplicate declarations in one batch", { input: [inline([functionTool("base"), functionTool("base", 2)])] }, ["base"]],
  ["duplicate namespace headers in one batch", { input: [inline([namespace([rawTool]), namespace([functionTool("base")])])] }, ["raw_fixture", "base"]],
  ["unsupported inline tool", { input: [inline([{ type: "web_search" }])] }, ["web_search"]],
  ["oversized input", { input: [inline([rawTool]), { role: "user", content: "x".repeat(4 * 1024 * 1024) }] }, ["raw_fixture"]],
]) {
  test(`experimental mirror fails closed: ${label}`, () => assert.equal(mirrorTools(payload, names), undefined));
}
