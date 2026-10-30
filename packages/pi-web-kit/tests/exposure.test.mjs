import assert from "node:assert/strict";
import test from "node:test";
import { WEB_TOOLS, directSelection, names, readRegistration } from "../src/exposure.ts";
import { WEB_OUTPUT_SCHEMAS } from "../src/output.ts";

const available = ["web_search", "web_fetch", "library_docs"];
const state = (patch = {}) => ({
  version: 2, tools: available, exposure: "direct", directActive: available, declared: available, positive: [], ...patch,
});
const select = (previous, active, { positive = [], disabled = () => false, observe = true, tools = available } = {}) =>
  directSelection(previous, active, tools, positive, disabled, observe);

test("the bounded exposure allowlist matches the registered output contracts", () => {
  assert.deepEqual([...WEB_TOOLS].sort(), Object.keys(WEB_OUTPUT_SCHEMAS).sort());
});

test("exposure history accepts bounded known versions and strips unrelated data", () => {
  assert.deepEqual(readRegistration({ version: 1, tools: ["web_search", "web_search"], credentials: "untrusted" }),
    { version: 1, tools: ["web_search"] });
  const parsed = readRegistration({ ...state(), unused: "untrusted" });
  assert.deepEqual(parsed, { ...state(), tools: names(available), directActive: names(available), declared: names(available) });
  for (const data of [null, [], {}, { version: 99, tools: [] }, { version: 1, tools: ["unknown"] },
    { version: 1, tools: Array(6).fill("web_search") }, state({ declared: ["codemode"] }),
    state({ exposure: "auto" }), state({ directActive: undefined }), state({ positive: "web_search" })]) {
    assert.equal(readRegistration(data), undefined);
  }
});

test("fresh availability selects enabled tools without treating deferred inactivity as a disable", () => {
  assert.deepEqual(select(undefined, ["read", "codemode"]), names(available));
  assert.deepEqual(select(state({ exposure: "deferred", declared: [] }), ["read", "codemode"]), names(available));
  assert.deepEqual(select(undefined, [], { disabled: name => name === "web_fetch" }), ["library_docs", "web_search"]);
});

test("observable manual removals and additions update the direct selection in either mode", () => {
  assert.deepEqual(select(state(), ["web_search"]), ["web_search"]);
  assert.deepEqual(select(state({ exposure: "deferred", declared: ["web_search"] }), []), ["library_docs", "web_fetch"]);
  assert.deepEqual(select(state({ directActive: [], declared: [] }), ["library_docs"]), ["library_docs"]);
});

test("startup and hard disable do not confuse incomplete or withdrawn declarations with choices", () => {
  assert.deepEqual(select(state(), [], { observe: false }), names(available));
  assert.deepEqual(select(state({ exposure: "hidden" }), []), names(available));
});

test("new positive settings and newly available tools do not undo existing manual choices", () => {
  const previous = state({ directActive: [], declared: [], positive: ["library_docs"] });
  assert.deepEqual(select(previous, [], { positive: ["library_docs"] }), []);
  assert.deepEqual(select(previous, [], { positive: ["library_docs", "web_fetch"] }), ["web_fetch"]);
  assert.deepEqual(select(previous, [], { positive: ["web_fetch"], disabled: () => true }), []);
  assert.deepEqual(select({ version: 1, tools: available }, [], { positive: ["library_docs"] }), [],
    "old history cannot show whether a positive setting is new");
  assert.deepEqual(select(state({ tools: ["web_search"], directActive: [], declared: [] }), []), ["library_docs", "web_fetch"]);
});
