import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { accountUsageFromBranch } from "../packages/pi-goal/src/accounting.ts";
import { goalState } from "./virtual-model-harness.mjs";
import { INPUT, PNG, PROBE_MODEL, PROBE_REF, imageResult, nativeImageHarness, resultText } from "./native-image-harness.mjs";

const generate = `await models.generateImages(${JSON.stringify(PROBE_REF)}, ${JSON.stringify(INPUT)})`;

test("production provider stays auth-only; discovery never generates and dedicated delivery remains available", async t => {
  const h = await nativeImageHarness(t, { native: false });
  assert.deepEqual(h.modelRuntime.getModelsOfType("image", "codex-images"), []);
  assert.deepEqual(h.modelRuntime.getModelsOfType("chat", "codex-images"), []);
  const discovery = await h.script(`
    text(await models.getModelsOfType("image", "codex-images"));
    text(await models.getAvailableOfType("image", "codex-images"));
    text(await describeNamespace("codex_images"));
  `);
  assert.equal(discovery.isError, false);
  assert.match(resultText(discovery), /codex_generate_image_artifact/);
  assert.equal(h.nativeCalls.length + h.imageRequests.length, 0);
  const direct = await h.run("codex_generate_image", { prompt: "fixture", save: "none" });
  assert.equal(direct.isError, false);
  assert.equal(direct.content.find(b => b.type === "image").data, PNG.toString("base64"));
  assert.equal(h.imageRequests.length, 1);
  assert.deepEqual(await h.imageFiles(), []);
});

test("probe catalog is image-only; owned OAuth availability does no image work", async t => {
  const h = await nativeImageHarness(t);
  assert.deepEqual(h.modelRuntime.getModelsOfType("image", "codex-images").map(m => m.id), [PROBE_MODEL.id]);
  assert.deepEqual(h.modelRuntime.getModelsOfType("chat", "codex-images"), []);
  assert.equal(h.modelRuntime.getModelOfType("chat", "codex-images", PROBE_MODEL.id), undefined);
  const result = await h.script(`
    const known = await models.getModelOfType("image", "codex-images", "fixture-native");
    const available = await models.getAvailableOfType("image", "codex-images");
    if (known.type !== "image" || available[0].id !== known.id) throw new Error("Missing image catalog entry");
    if ((await models.getModelsOfType("chat", "codex-images")).length) throw new Error("Chat leak");
    text("image only");
  `);
  assert.equal(result.isError, false, resultText(result));
  assert.equal(h.nativeCalls.length + h.imageRequests.length, 0);
});

test("native preparation does not inherit the dedicated tool's absent-owned-only legacy fallback", async t => {
  const h = await nativeImageHarness(t, { owned: "absent" });
  assert.deepEqual(await h.modelRuntime.getAvailableOfType("image", "codex-images"), []);
  const result = await h.modelRuntime.generateImages(PROBE_MODEL, INPUT);
  assert.equal(result.stopReason, "error");
  assert.equal(h.nativeCalls.length, 0);
  const direct = await h.run("codex_generate_image", { prompt: "fixture", save: "none" });
  assert.equal(direct.isError, false, resultText(direct));
  assert.equal(h.imageRequests.length, 1);
});

for (const native of [false, true]) for (const owned of ["api-key", "invalid-oauth"]) {
  test(`configured ${owned} image credentials never fall back to legacy OAuth (probe=${native})`, async t => {
    const h = await nativeImageHarness(t, { owned, native });
    if (native) {
      const result = await h.modelRuntime.generateImages(PROBE_MODEL, INPUT);
      assert.equal(result.stopReason, "error");
      assert.equal(h.nativeCalls.length, 0);
    }
    for (const artifact of [false, true]) {
      const result = artifact
        ? await h.script('await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});')
        : await h.run("codex_generate_image", { prompt: "fixture", save: "none" });
      assert.equal(result.isError, true);
      assert.equal(h.imageAttempts, 0, "Configured but unsupported is not absent");
      assert.match(resultText(result), /Image authentication failed/);
    }
    assert.equal(h.imageRequests.length, 0, "No API-key or legacy billing fallback");
    assert.deepEqual(await h.imageFiles(), []);
  });
}

test("raw native SDK results preserve bytes but neither save nor automatically record usage", async t => {
  const h = await nativeImageHarness(t);
  const result = await h.ctx.modelRegistry.generateImages(PROBE_MODEL, INPUT, {
    metadata: { fixture: "SDK-only" }, signal: new AbortController().signal,
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.output[0].data, PNG.toString("base64"));
  assert.equal(result.responseId, "response_fixture");
  assert.equal(result.model, "fixture-native", "Operation identity, not backend-model evidence");
  assert.equal(result.usage.totalTokens, 42);
  assert.deepEqual(h.nativeCalls[0].metadata, { fixture: "SDK-only" });
  assert.deepEqual(await h.imageFiles(), []);
  assert.equal(h.records().length, 0);
  assert.equal(h.session.getSessionStats().tokens.total, 0);
  assert.equal(goalState(h).tokensUsed, 0, "Missing attribution is not evidence of free generation");
});

for (const mode of ["on", "only"]) {
  test(`codemode ${mode}: catalog identity, explicit image delivery and single-count metering`, async t => {
    const h = await nativeImageHarness(t, { mode });
    const result = await h.script(`
      const result = await models.generateImages({
        ...${JSON.stringify(PROBE_REF)}, baseUrl: "https://wrong.invalid", headers: {Authorization: "wrong"}
      }, ${JSON.stringify(INPUT)});
      if (result.stopReason !== "stop") throw new Error(result.errorMessage);
      for (const block of result.output) image(block);
      text({model: result.model, responseId: result.responseId});
    `);
    assert.equal(result.isError, false, resultText(result));
    assert.equal(result.content.find(b => b.type === "image").data, PNG.toString("base64"));
    const files = await h.imageFiles();
    assert.equal(files.length, 1);
    assert.deepEqual(await readFile(join(h.root, files[0])), PNG);
    assert.equal(h.nativeCalls.length, 1);
    assert.equal(h.nativeCalls[0].model.baseUrl, PROBE_MODEL.baseUrl);
    assert.equal(h.nativeCalls[0].oauth, true);
    assert.ok(!h.nativeCalls[0].headers?.Authorization);
    assert.equal(result.usage.totalTokens, 42);
    assert.equal(goalState(h).tokensUsed, 64);
    assert.equal(h.records().length, 0, "Generic display copies are not package recovery artifacts");
    await h.session.reload();
    assert.equal(goalState(h).tokensUsed, 64);
    assert.equal(accountUsageFromBranch(goalState(h), h.sessionManager.getBranch()).addedTokens, 0);
  });
}

test("generic image edits accept explicit read blocks and prior outputs, without branch-aware selectors", async t => {
  const h = await nativeImageHarness(t);
  const path = join(h.root, "reference.png");
  await writeFile(path, PNG);
  const result = await h.script(`
    const reference = await tools.read({path:${JSON.stringify(path)}});
    const first = await models.generateImages(${JSON.stringify(PROBE_REF)}, {
      input: [{type:"text",text:"Fixture edit"}, reference]
    });
    const second = await models.generateImages(${JSON.stringify(PROBE_REF)}, {
      input: [{type:"text",text:"Second fixture edit"}, ...first.output]
    });
    text(second.stopReason);
  `);
  assert.equal(result.isError, false, resultText(result));
  assert.equal(h.nativeCalls.length, 2);
  for (const call of h.nativeCalls) assert.equal(call.context.input[1].data, PNG.toString("base64"));
  assert.equal(result.usage.totalTokens, 84);
  assert.equal(goalState(h).tokensUsed, 106);
  assert.equal(h.records().length, 0);
});

test("generic display save failure keeps the inline image but creates no recovery artifact", async t => {
  const h = await nativeImageHarness(t);
  const blocked = join(h.root, "blocked-temp");
  await writeFile(blocked, "fixture");
  process.env.TMPDIR = blocked;
  let result;
  try {
    result = await h.script(`const result = ${generate}; image(result.output[0]);`);
  } finally {
    process.env.TMPDIR = h.root;
  }
  assert.equal(result.isError, false, resultText(result));
  assert.match(resultText(result), /could not be saved/);
  assert.equal(result.content.find(b => b.type === "image").data, PNG.toString("base64"));
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(h.records().length, 0);
  assert.deepEqual(await h.imageFiles(), []);
});

test("native SDK model objects are trusted input; unlike scripts they are not catalog references only", async t => {
  const h = await nativeImageHarness(t);
  const result = await h.modelRuntime.generateImages({ ...PROBE_MODEL, baseUrl: "https://wrong.invalid" }, INPUT);
  assert.equal(result.stopReason, "stop");
  assert.equal(h.nativeCalls[0].model.baseUrl, "https://wrong.invalid");
  assert.equal(h.imageRequests.length, 0, "Test callback never fetches; a Codex adapter must retain its fixed endpoint");
});

test("generic context has only block-shape validation, not the package's input limits or controls", async t => {
  const h = await nativeImageHarness(t);
  const result = await h.script(`
    const result = await models.generateImages(${JSON.stringify(PROBE_REF)}, {
      input: [{type:"text", text:"x".repeat(32001)}, ...Array(6).fill({type:"image",data:"invalid",mimeType:"image/svg+xml"})],
      save: "custom", saveDir: "unsupported-control"
    }, {metadata:{outputFormat:"webp"}});
    text(result.stopReason);
  `);
  assert.equal(result.isError, false, resultText(result));
  assert.equal(h.nativeCalls.length, 1);
  const call = h.nativeCalls[0];
  assert.equal(call.context.input[0].text.length, 32001);
  assert.equal(call.context.input.length, 7);
  assert.equal(call.context.save, "custom", "Unknown context keys pass through; they are NOT supported controls");
  assert.equal(call.metadata, undefined, "Codemode's API does not forward a third options argument");
  assert.deepEqual(await h.imageFiles(), []);
});

test("invalid generic shape and unknown/chat-only catalog references fail before the image provider", async t => {
  const h = await nativeImageHarness(t);
  for (const code of [
    `await models.generateImages(${JSON.stringify(PROBE_REF)}, {prompt:"wrong shape"})`,
    `await models.generateImages({provider:"openai-codex",id:"gpt-6-astra"}, ${JSON.stringify(INPUT)})`,
    `await models.generateImages({...${JSON.stringify(PROBE_REF)}, id:"not-known"}, ${JSON.stringify(INPUT)})`,
  ]) {
    const result = await h.script(code);
    assert.equal(result.isError, true);
  }
  assert.equal(h.nativeCalls.length + h.imageRequests.length, 0);
});

for (const ending of ["forgotten", "script failure"]) {
  test(`native image ${ending}: metering survives but there is no saved original or recovery entry`, async t => {
    const h = await nativeImageHarness(t);
    const result = await h.script(`${generate}; ${ending === "script failure" ? 'throw new Error("synthetic later failure");' : 'text("not displayed");'}`);
    assert.equal(result.isError, ending === "script failure");
    assert.match(resultText(result), /returned 1 image that the script did not show/);
    assert.deepEqual(await h.imageFiles(), []);
    assert.equal(h.records().length, 0);
    assert.equal(result.usage.totalTokens, 42);
    assert.equal(goalState(h).tokensUsed, 64);
    await h.session.reload();
    await h.session.prompt("/image-artifacts");
    assert.match(h.session.messages.at(-1).content, /No image artifacts/);
    assert.equal(h.nativeCalls.length, 1, "Recovery listing does not regenerate");
  });
}

test("large native display exhausts the VM before recovery, after the metered operation completed", async t => {
  const h = await nativeImageHarness(t);
  // Same valid PNG prefix with padding as the existing 32 MiB artifact test.
  // This is a byte-transport probe, not a realistic large image or decoder test.
  const bytes = Buffer.alloc(13 * 1024 * 1024);
  PNG.copy(bytes);
  h.generate = () => imageResult(bytes);
  const result = await h.script(`const result = ${generate}; image(result.output[0]);`);
  assert.equal(result.isError, true);
  assert.match(resultText(result), /out of memory in regexp execution/);
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(result.usage.totalTokens, 42);
  assert.equal(goalState(h).tokensUsed, 64);
  assert.deepEqual(await h.imageFiles(), []);
  assert.equal(h.records().length, 0);
});

test("text and image share the aggregate script budget; output rejection does not undo image usage", async t => {
  const h = await nativeImageHarness(t);
  const result = await h.script(`// @options: {"max_output_tokens": 200}
    const result = ${generate};
    text("x".repeat(16777216 - 16));
    image(result.output[0]);
  `);
  assert.equal(result.isError, true);
  assert.match(resultText(result), /output.*limit|limit.*output/i);
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(result.usage.totalTokens, 42);
  assert.equal(goalState(h).tokensUsed, 64);
  assert.deepEqual(await h.imageFiles(), []);
  assert.equal(h.records().length, 0);
});

test("native calls do not traverse image tool approvals, while the outer codemode gate remains authoritative", async t => {
  let denied = 0;
  let blockScript = false;
  const h = await nativeImageHarness(t, { factories: [pi => pi.on("tool_call", event => {
    if (event.toolName.startsWith("codex_generate_image") || (blockScript && event.toolName === "codemode")) {
      denied++;
      return { block: true, reason: "Fixture denied tool" };
    }
  })] });
  const result = await h.script(`
    try { await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"}); }
    catch { text("tool denied"); }
    const result = ${generate}; text(result.stopReason);
  `);
  assert.equal(result.isError, false, resultText(result));
  assert.equal(denied, 1);
  assert.equal(h.imageRequests.length, 0);
  assert.equal(h.nativeCalls.length, 1, "A different operation surface, not an inherited tool approval");
  assert.ok(h.toolCalls.every(call => !call.name.startsWith("models.")));
  blockScript = true;
  const blocked = await h.script(generate);
  assert.equal(blocked.isError, true);
  assert.equal(h.nativeCalls.length, 1);
});

test("image tool exclusions do not remove a separately registered native image operation", async t => {
  const h = await nativeImageHarness(t, { excludeTools: ["codex_generate_image", "codex_generate_image_artifact"] });
  const result = await h.script(`
    if ("codex_generate_image_artifact" in tools || "codex_generate_image" in tools) throw new Error("Excluded tool leaked");
    const result = ${generate}; text(result.stopReason);
  `);
  assert.equal(result.isError, false, resultText(result));
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(h.imageRequests.length, 0);
});

for (const failure of ["returned", "thrown"]) {
  test(`native ${failure} error is explicit, with no automatic retry or invented usage`, async t => {
    const h = await nativeImageHarness(t);
    h.generate = () => {
      if (failure === "thrown") throw new Error("Synthetic failure; no retry");
      return imageResult(PNG, { output: [], stopReason: "error", errorMessage: "Synthetic quota failure", usage: undefined });
    };
    const result = await h.script(`const result = ${generate}; text({reason: result.stopReason, error: result.errorMessage});`);
    assert.equal(result.isError, false, "Callers must inspect the terminal result, not just script success");
    assert.match(resultText(result), /"reason":"error"/);
    assert.equal(h.nativeCalls.length, 1);
    assert.equal(goalState(h).tokensUsed, 22, "Unreported usage must not be called free");
    assert.deepEqual(await h.imageFiles(), []);
  });
}

test("reported usage on a native error counts once even though no image is delivered", async t => {
  const h = await nativeImageHarness(t);
  h.generate = () => imageResult(PNG, { output: [], stopReason: "error", errorMessage: "Synthetic metered error" });
  const result = await h.script(`const result = ${generate}; text(result.stopReason);`);
  assert.equal(result.isError, false);
  assert.equal(result.usage.totalTokens, 42);
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(goalState(h).tokensUsed, 64);
  await h.session.reload();
  assert.equal(goalState(h).tokensUsed, 64);
  assert.deepEqual(await h.imageFiles(), []);
});

test("native cancellation retains prior reported usage and aborts pending work without retry", { timeout: 10_000 }, async t => {
  const h = await nativeImageHarness(t);
  const entered = Promise.withResolvers();
  let cancelled = false;
  h.generate = (_model, _context, { signal }) => {
    if (h.nativeCalls.length === 1) return imageResult();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(new Error("Synthetic cancellation")); }, { once: true });
      entered.resolve();
    });
  };
  const run = h.script(`${generate}; ${generate};`);
  await entered.promise;
  await h.session.abort();
  await run;
  assert.equal(cancelled, true);
  assert.equal(h.nativeCalls.length, 2);
  assert.equal(h.chatRequests.length, 1);
  assert.equal(goalState(h).tokensUsed, 53);
  assert.deepEqual(await h.imageFiles(), []);
  await h.session.reload();
  assert.equal(goalState(h).tokensUsed, 53);
});

test("a tool-owned native result reports its usage once, without a second request or codemode charge", async t => {
  const h = await nativeImageHarness(t, { factories: [pi => pi.registerTool({
    name: "fixture_image_wrapper", label: "Fixture", description: "Test-only metering wrapper", parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const result = await ctx.modelRegistry.generateImages(PROBE_MODEL, INPUT, { signal });
      return { content: [{ type: "text", text: result.stopReason }], details: undefined, usage: result.usage };
    },
  })] });
  const result = await h.script("text(await tools.fixture_image_wrapper({}));");
  assert.equal(result.isError, false, resultText(result));
  assert.equal(result.usage.totalTokens, 42);
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(goalState(h).tokensUsed, 64);
  await h.session.reload();
  assert.equal(goalState(h).tokensUsed, 64);
});

test("dedicated artifact preserves failed-save recovery and informational usage, not native metering", async t => {
  const h = await nativeImageHarness(t, { native: false });
  await writeFile(join(h.root, "blocked"), "fixture");
  const result = await h.script(`
    const result = await tools.codex_generate_image_artifact({prompt:"fixture",save:"custom",saveDir:"blocked"});
    text(result);
  `);
  assert.equal(result.isError, false, resultText(result));
  assert.match(resultText(result), /could not be saved/);
  const record = h.records()[0].data;
  assert.deepEqual(await readFile(record.artifact.path), PNG);
  assert.equal(h.imageRequests.length, 1);
  const nested = h.toolResults.find(event => event.toolName === "codex_generate_image_artifact");
  assert.equal(nested.details.usage.total_tokens, 42);
  assert.equal(nested.details.backendImageModel, "unknown");
  assert.equal(nested.details.reportedImage.size, "2048x2048", "Reported metadata is not pixel evidence");
  assert.equal(result.usage, undefined);
  assert.equal(goalState(h).tokensUsed, 22, "Existing informational counters are not a usage ledger entry");
});

test("fixture teardown restores process globals and image-related environment", async t => {
  const fetch = globalThis.fetch;
  const socket = globalThis.WebSocket;
  const keys = ["HOME", "TMPDIR", "PI_CODING_AGENT_DIR", "CI", "PI_OFFLINE", "PI_TELEMETRY",
    "PI_CODEX_IMAGE_SAVE_MODE", "PI_CODEX_IMAGE_SAVE_DIR"];
  const before = new Map(keys.map(key => [key, process.env[key]]));
  await t.test("owned disposable fixture", async child => {
    const h = await nativeImageHarness(child);
    await h.modelRuntime.generateImages(PROBE_MODEL, INPUT);
  });
  assert.equal(globalThis.fetch, fetch);
  assert.equal(globalThis.WebSocket, socket);
  // Never give an environment object/value to assert: failure diagnostics can
  // expose inherited credentials. Compare booleans and report key names only.
  for (const key of keys) assert.ok(process.env[key] === before.get(key), `Environment was not restored: ${key}`);
});
