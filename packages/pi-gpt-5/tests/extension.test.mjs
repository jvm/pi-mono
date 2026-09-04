import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.CI = "1";
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-gpt-5-extension-test-"));

const { default: piGpt5 } = await import("../extensions/index.ts");
const { MODEL_FEATURES, featuresFor } = await import("../src/features.ts");
const { DEFAULT_SETTINGS, applyCorePack, applyImageDetail } = await import("../src/core-pack.ts");
const { resolveProModeEntitlement } = await import("../src/entitlement.ts");

function makePi() {
  const commands = new Map();
  return {
    commands,
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerShortcut() {},
    on() {},
  };
}

const IMG = { type: "input_image", detail: "auto", image_url: "data:image/png;base64,x" };

function payloadWithImage() {
  return {
    model: "gpt-5.6-sol",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, { ...IMG }] },
    ],
    reasoning: { effort: "high", summary: "auto" },
  };
}

test("extension registers /gpt5 and loads", () => {
  const pi = makePi();
  piGpt5(pi);
  assert.equal(pi.commands.has("gpt5"), true);
});

test("applyCorePack is passive for unknown models and untouched payloads", () => {
  const payload = payloadWithImage();
  assert.equal(applyCorePack(payload, { ...DEFAULT_SETTINGS, proMode: true }, undefined), payload);
  assert.equal(applyCorePack(payload, DEFAULT_SETTINGS, MODEL_FEATURES["gpt-5.6-sol"]), payload);
  assert.equal(applyCorePack("string-input", DEFAULT_SETTINGS, MODEL_FEATURES["gpt-5.6-sol"]), "string-input");
});

test("pro mode merges into reasoning without dropping effort", () => {
  const out = applyCorePack(payloadWithImage(), { ...DEFAULT_SETTINGS, proMode: true }, MODEL_FEATURES["gpt-5.6-sol"]);
  assert.deepEqual(out.reasoning, { effort: "high", summary: "auto", mode: "pro" });
});

test("pro mode never applies to non-5.6 models even when toggled", () => {
  const payload = payloadWithImage();
  const out = applyCorePack(payload, { ...DEFAULT_SETTINGS, proMode: true }, MODEL_FEATURES["gpt-5.5"]);
  assert.equal(out.reasoning.mode, undefined);
});

test("reasoning context and verbosity pins respect gates and auto", () => {
  const out = applyCorePack(
    payloadWithImage(),
    { ...DEFAULT_SETTINGS, reasoningContext: "current_turn", verbosity: "high" },
    MODEL_FEATURES["gpt-5.6-sol"],
  );
  assert.equal(out.reasoning.context, "current_turn");
  assert.deepEqual(out.text, { verbosity: "high" });

  const gated = applyCorePack(
    payloadWithImage(),
    { ...DEFAULT_SETTINGS, reasoningContext: "all_turns", verbosity: "low" },
    MODEL_FEATURES["gpt-5.3-codex"], // persistedReasoning and verbosity both false
  );
  assert.equal(gated.reasoning.context, undefined);
  assert.equal(gated.text, undefined);
});

test("image detail pins rewrite parts; original clamps to high off 5.6", () => {
  const out = applyImageDetail(payloadWithImage(), "original", MODEL_FEATURES["gpt-5.6-sol"]);
  assert.equal(out.input[0].content[1].detail, "original");

  const clamped = applyImageDetail(payloadWithImage(), "original", MODEL_FEATURES["gpt-5.5"]);
  assert.equal(clamped.input[0].content[1].detail, "high");

  const pinned = applyImageDetail(payloadWithImage(), "low", MODEL_FEATURES["gpt-5.5"]);
  assert.equal(pinned.input[0].content[1].detail, "low");
});

test("gate table invariants hold", () => {
  for (const [id, f] of Object.entries(MODEL_FEATURES)) {
    assert.ok(f.efforts.length > 0, id);
    assert.equal(f.proMode && f.legacyProSlug, false, id);
    assert.equal(f.programmaticToolCalling, f.multiAgent, `${id}: PTC and multi-agent ship together`);
  }
  assert.equal(featuresFor("gpt-5.6"), featuresFor("gpt-5.6-sol"));
  assert.equal(featuresFor("gpt-4.1"), undefined);
});

test("entitlement allows api-key, warns on oauth, unknown registry warns", () => {
  assert.deepEqual(
    { ...resolveProModeEntitlement({ isUsingOAuth: () => false }, { id: "gpt-5.6-sol" }) },
    { allowed: true, authKind: "api-key" },
  );
  const oauth = resolveProModeEntitlement({ isUsingOAuth: () => true }, { id: "gpt-5.6-sol" });
  assert.equal(oauth.allowed, true);
  assert.equal(oauth.authKind, "oauth");
  assert.ok(oauth.warning);

  const unknown = resolveProModeEntitlement({}, { id: "gpt-5.6-sol" });
  assert.equal(unknown.authKind, "unknown");
  assert.ok(unknown.warning);

  assert.equal(resolveProModeEntitlement({ isUsingOAuth: () => false }, undefined).allowed, false);
});
