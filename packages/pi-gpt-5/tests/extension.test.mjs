import assert from "node:assert/strict";
import test from "node:test";

process.env.CI = "1";
process.env.PI_CODING_AGENT_DIR = await mkdtemp();

async function mkdtemp() {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtemp(join(tmpdir(), "pi-gpt-5-extension-test-"));
}

const { default: piGpt5 } = await import("../extensions/index.ts");
const { MODEL_FEATURES, featuresFor } = await import("../src/features.ts");

function makePi() {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands,
    handlers,
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerShortcut() {},
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
}

test("extension registers /gpt5 and loads", () => {
  const pi = makePi();
  piGpt5(pi);
  assert.equal(pi.commands.has("gpt5"), true);
});

test("every registered gate is internally consistent", () => {
  for (const [id, f] of Object.entries(MODEL_FEATURES)) {
    assert.ok(f.efforts.length > 0, `${id}: efforts must not be empty`);
    assert.equal(
      f.proMode && f.legacyProSlug,
      false,
      `${id}: proMode and legacyProSlug are mutually exclusive`,
    );
    if (!f.persistedReasoning) {
      assert.equal(f.reasoningContextDefault, "current_turn", `${id}`);
    }
    if (f.programmaticToolCalling || f.multiAgent || f.originalImageDetail) {
      assert.equal(f.explicitPromptCacheMode, true, `${id}: 5.6-only features imply explicit caching`);
    }
  }
});

test("gpt-5.6 family carries the full 5.6 surface; older models do not", () => {
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const f = MODEL_FEATURES[id];
    assert.equal(f.proMode, true, id);
    assert.equal(f.persistedReasoning, true, id);
    assert.equal(f.programmaticToolCalling, true, id);
    assert.equal(f.multiAgent, true, id);
    assert.deepEqual(f.efforts, ["none", "low", "medium", "high", "xhigh", "max"], id);
  }
  for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5"]) {
    assert.equal(MODEL_FEATURES[id].proMode, false, id);
    assert.equal(MODEL_FEATURES[id].programmaticToolCalling, false, id);
    assert.equal(MODEL_FEATURES[id].multiAgent, false, id);
  }
});

test("alias resolves and unknown models return undefined", () => {
  assert.equal(featuresFor("gpt-5.6"), featuresFor("gpt-5.6-sol"));
  assert.equal(featuresFor("gpt-4.1"), undefined);
  assert.equal(featuresFor("some-future-model"), undefined);
});
