import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createCodemodeExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codexHarness, requestBody, textResponse } from "../../../tests/codex-harness.mjs";
import imageExtension from "../.test-dist/extensions/index.js";
import { ARTIFACT_ENTRY, RESERVATION_ENTRY, artifactRecord, branchArtifacts, readArtifactManifest, reserveArtifact } from "../.test-dist/src/artifacts.js";
import { REQUEST_TIMEOUT_MS } from "../.test-dist/src/codex-response.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);

function eventsResponse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function callResponse(name, args) {
  const custom = name === "codemode";
  const item = custom
    ? { type: "custom_tool_call", id: "ct_fixture", call_id: "call_fixture", name, input: args }
    : { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name, arguments: JSON.stringify(args) };
  return eventsResponse([
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(custom ? { input: "" } : { arguments: "" }) } },
    {
      type: custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
      output_index: 0, item_id: item.id, delta: custom ? args : JSON.stringify(args),
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ]);
}

function imageResponse(bytes = PNG) {
  return eventsResponse([
    { type: "response.output_item.done", item: {
      type: "image_generation_call", id: "image-fixture", status: "completed", result: bytes.toString("base64"),
    } },
    { type: "response.completed", response: { id: "response-fixture", usage: { total_tokens: 1 } } },
  ]);
}

async function fixture(t, mode = "only", factories = []) {
  const root = await mkdtemp(join(tmpdir(), "image-codemode-test-"));
  const previous = Object.fromEntries(["TMPDIR", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_CODEX_IMAGE_SAVE_MODE", "PI_CODEX_IMAGE_SAVE_DIR"].map(key => [key, process.env[key]]));
  process.env.TMPDIR = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_OFFLINE = "1";
  delete process.env.PI_CODEX_IMAGE_SAVE_MODE;
  delete process.env.PI_CODEX_IMAGE_SAVE_DIR;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unmocked network blocked"); };
  const nested = [];
  const h = await codexHarness([
    ...(mode ? [createCodemodeExtension({ mode })] : []),
    imageExtension,
    ...factories,
    pi => pi.on("tool_result", event => { if (event.parentToolCallId) nested.push(event); }),
  ], {
    defaultTools: ["read", "codex_generate_image", ...(mode ? ["codemode"] : [])],
    sessionManager: SessionManager.create(root, join(root, "sessions")),
  });
  t.after(async () => {
    await h.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const imageRequests = [];
  const chatRequests = [];
  let call;
  let imageHandler = () => imageResponse();
  globalThis.fetch = async (_url, init) => {
    const body = requestBody(init);
    if (body.tools?.some(tool => tool.type === "image_generation")) {
      imageRequests.push(body);
      return imageHandler(body);
    }
    chatRequests.push(body);
    if (call) {
      const next = call;
      call = undefined;
      return callResponse(...next);
    }
    return textResponse();
  };
  return {
    ...h, root, nested, imageRequests, chatRequests,
    records: () => h.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === ARTIFACT_ENTRY),
    setImageHandler(handler) { imageHandler = handler; },
    async runInSession(session, name, args) {
      call = [name, args];
      await session.prompt("Exercise fixture only. Network and credentials are synthetic.");
      const result = session.messages.findLast(message => message.role === "toolResult");
      assert.deepEqual(h.errors, []);
      return result;
    },
    run(name, args) { return this.runInSession(h.session, name, args); },
    script(code) { return this.run("codemode", code); },
  };
}

for (const mode of [undefined, "on", "only"]) {
  test(`direct inline delivery and model-only exposure with codemode ${mode ?? "off"}`, async t => {
    const h = await fixture(t, mode ?? null);
    const result = await h.run("codex_generate_image", { prompt: "fixture", save: "none" });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.content.find(block => block.type === "image")?.data, PNG.toString("base64"));
    assert.equal(h.imageRequests.length, 1);
    assert.equal(h.records().length, 0);
    const declared = h.chatRequests[0].tools.map(tool => tool.name);
    assert.ok(declared.includes("codex_generate_image"));
    assert.ok(!declared.includes("codex_generate_image_artifact"));
  });
}

for (const mode of ["on", "only"]) {
  test(`discovery and nested attempts do not generate images (${mode})`, async t => {
    const h = await fixture(t, mode);
    const result = await h.script(`
      text(ALL_TOOLS.some(tool => tool.name === "codex_generate_image"));
      text(await describeTool("codex_generate_image_artifact"));
      try { await tools.codex_generate_image({prompt:"fixture", save:"none"}); }
      catch (error) { text(error.message); }
    `);
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result.content), /false/);
    assert.match(JSON.stringify(result.content), /artifact/);
    assert.equal(h.imageRequests.length, 0);
    assert.equal(h.records().length, 0);
    assert.ok(!h.nested.some(event => event.toolName === "codex_generate_image"));
  });
}

test("nested artifact metadata reaches the parent; explicit read/image delivers an attachment", async t => {
  const h = await fixture(t);
  const result = await h.script(`
    const result = await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});
    text(result);
    image(await tools.read({path:result.artifact.path}));
  `);
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.ok(result.content.some(block => block.type === "image"));
  const generated = h.nested.find(event => event.toolName === "codex_generate_image_artifact");
  assert.equal(generated.content.some(block => block.type === "image"), false);
  assert.ok(generated.structuredContent.artifact.path);
  assert.doesNotMatch(JSON.stringify(generated.structuredContent), /base64|iVBOR/);
  const record = artifactRecord(h.records()[0].data);
  assert.deepEqual(await readFile(record.artifact.path), PNG);
  assert.equal((await stat(record.artifact.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(record.artifact.path, ".."))).mode & 0o777, 0o700);
});

test("artifact tool supports other orchestrators and explicit direct activation", async t => {
  const h = await fixture(t, "on", [pi => pi.registerTool({
    name: "fixture_orchestrator", label: "Fixture", description: "Fixture only", exposure: "model-only",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const outcome = await ctx.executeTool("codex_generate_image_artifact", { prompt: "fixture", save: "none" });
      assert.equal(outcome.isError, false);
      return outcome.result;
    },
  })]);
  const nested = await h.run("fixture_orchestrator", {});
  assert.equal(nested.isError, false, JSON.stringify(nested.content));
  h.api.setActiveTools([...h.api.getActiveTools(), "codex_generate_image_artifact"]);
  const direct = await h.run("codex_generate_image_artifact", { prompt: "fixture", save: "none" });
  assert.equal(direct.isError, false);
  assert.ok(direct.details.artifact.path);
  assert.equal(direct.content.some(block => block.type === "image"), false);
  assert.equal(h.imageRequests.length, 2);
});

test("artifacts remain available for chained path edits and recent-image edits", async t => {
  const h = await fixture(t);
  const result = await h.script(`
    const first = await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});
    await tools.codex_generate_image_artifact({prompt:"edit",save:"none",referencedImagePaths:[first.artifact.path]});
    text(await tools.codex_generate_image_artifact({prompt:"recent edit",save:"none",numLastImagesToInclude:1}));
  `);
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.equal(h.imageRequests.length, 3);
  for (const request of h.imageRequests.slice(1)) {
    assert.equal(request.input[0].content[1].image_url, `data:image/png;base64,${PNG.toString("base64")}`);
  }
  assert.equal(h.records().length, 3);
});

for (const [format, bytes, suffix] of [["png", PNG, "png"], ["jpeg", JPEG, "jpg"], ["webp", WEBP, "webp"]]) {
  test(`artifact originals preserve ${format} bytes`, async t => {
    const h = await fixture(t);
    h.setImageHandler(() => imageResponse(bytes));
    const result = await h.script(`text(await tools.codex_generate_image_artifact({prompt:"fixture",save:"none",outputFormat:"${format}"}));`);
    assert.equal(result.isError, false);
    const { artifact } = h.records()[0].data;
    assert.ok(artifact.path.endsWith(`.${suffix}`));
    assert.deepEqual(await readFile(artifact.path), bytes);
  });
}

for (const save of ["project", "global", "custom"]) {
  test(`artifact and ${save} persistent copy coexist`, async t => {
    const h = await fixture(t);
    const result = await h.script(`text(await tools.codex_generate_image_artifact({prompt:"fixture",save:"${save}",saveDir:"out"}));`);
    assert.equal(result.isError, false);
    const data = h.nested.find(event => event.toolName === "codex_generate_image_artifact").structuredContent;
    assert.notEqual(data.artifact.path, data.savedPath);
    assert.deepEqual(await readFile(data.artifact.path), PNG);
    assert.deepEqual(await readFile(data.savedPath), PNG);
    assert.equal(data.saveWarning, undefined);
    const repeated = await h.script(`text(await tools.codex_generate_image_artifact({prompt:"fixture",save:"${save}",saveDir:"out"}));`);
    assert.equal(repeated.isError, false);
    const latest = h.nested.filter(event => event.toolName === "codex_generate_image_artifact").at(-1).structuredContent;
    assert.equal(latest.savedPath, undefined);
    assert.match(latest.saveWarning, /could not be saved/);
    assert.deepEqual(await readFile(data.savedPath), PNG);
    assert.deepEqual(await readFile(latest.artifact.path), PNG);
  });
}

test("failed persistent save still delivers metadata and a recoverable original", async t => {
  const h = await fixture(t);
  await writeFile(join(h.ctx.cwd, "blocked"), "not a directory");
  const result = await h.script(`text(await tools.codex_generate_image_artifact({prompt:"fixture",save:"custom",saveDir:"blocked"}));`);
  assert.equal(result.isError, false);
  const data = h.nested.find(event => event.toolName === "codex_generate_image_artifact").structuredContent;
  assert.equal(data.savedPath, undefined);
  assert.ok(data.saveWarning.length < 1000);
  assert.deepEqual(await readFile(data.artifact.path), PNG);
  assert.equal(h.imageRequests.length, 1);
});

test("known unavailable artifact storage rejects before any image work", async t => {
  const h = await fixture(t);
  process.env.TMPDIR = join(h.root, "missing-root");
  const result = await h.script(`await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});`);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /No generation request was made/);
  assert.equal(h.imageRequests.length, 0);
});

for (const save of ["none", "custom"]) {
  test(`post-generation artifact failure has no false success or retry (${save})`, async t => {
    const h = await fixture(t);
    h.setImageHandler(async () => {
      const dir = (await readdir(h.root)).find(name => name.startsWith("pi-codex-image-"));
      await unlink(join(h.root, dir, "original.png"));
      return imageResponse();
    });
    const result = await h.script(`text(await tools.codex_generate_image_artifact({prompt:"fixture",save:"${save}",saveDir:"out"}));`);
    assert.equal(h.imageRequests.length, 1);
    if (save === "none") {
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /quota may have been consumed/);
      assert.equal(h.records().length, 0);
    } else {
      assert.equal(result.isError, false, JSON.stringify(result.content));
      const data = h.nested.find(event => event.toolName === "codex_generate_image_artifact").structuredContent;
      assert.equal(data.artifact.path, data.savedPath);
      assert.match(data.saveWarning, /Temporary artifact storage failed/);
      assert.deepEqual(await readFile(data.artifact.path), PNG);
    }
    assert.equal((await readdir(h.root)).filter(name => name.startsWith("pi-codex-image-")).length, save === "none" ? 0 : 1);
  });
}

test("32 MiB originals use bounded metadata transport and bounded explicit display", async t => {
  const h = await fixture(t);
  const large = Buffer.alloc(32 * 1024 * 1024);
  PNG.copy(large);
  h.setImageHandler(() => imageResponse(large));
  const result = await h.script(`
    const result = await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});
    text(result);
    image(await tools.read({path:result.artifact.path}));
  `);
  assert.equal(result.isError, false, JSON.stringify(result.content.filter(block => block.type === "text")));
  const { artifact } = h.records()[0].data;
  assert.equal(artifact.byteCount, large.length);
  assert.deepEqual(await readFile(artifact.path), large);
  assert.ok(result.content.find(block => block.type === "image").data.length < 16_777_216);
  assert.ok(JSON.stringify(h.nested.find(event => event.toolName === "codex_generate_image_artifact").structuredContent).length < 2000);
  const recent = await h.script(`await tools.codex_generate_image_artifact({prompt:"fixture edit",save:"none",numLastImagesToInclude:2});`);
  assert.equal(recent.isError, true);
  assert.equal(h.imageRequests.length, 1);
  // The branch contains the original and its displayed preview. Request both
  // to verify that the original still receives the 20 MiB input bound.
  assert.match(JSON.stringify(recent.content), /20 MiB/);
});

test("script failure, reload and branch changes preserve completed artifact recovery", async t => {
  const h = await fixture(t);
  const branchPoint = h.sessionManager.appendCustomEntry("fixture-start", {});
  const result = await h.script(`
    await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});
    throw new Error("fixture failure after generation");
  `);
  assert.equal(result.isError, true);
  const record = h.records()[0];
  assert.deepEqual(await readFile(record.data.artifact.path), PNG);
  await h.session.reload();
  await h.session.prompt("/image-artifacts");
  assert.equal(h.imageRequests.length, 1);
  assert.match(JSON.stringify(h.session.messages.at(-1)), /original.png/);
  const recent = await h.script(`text(await tools.codex_generate_image_artifact({prompt:"edit",save:"none",numLastImagesToInclude:1}));`);
  assert.equal(recent.isError, false);
  const newLeaf = h.sessionManager.getLeafId();
  h.sessionManager.branch(branchPoint);
  assert.equal(h.records().length, 0);
  h.sessionManager.branch(newLeaf);
  assert.equal(h.records().length, 2);
  assert.deepEqual(await readFile(record.data.artifact.path), PNG);
});

test("a fresh session runtime resumes artifact recovery and recent editing from disk", async t => {
  const h = await fixture(t);
  await h.script(`await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});`);
  const first = h.records()[0].data.artifact;
  const sessionFile = h.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  const resumed = await codexHarness([createCodemodeExtension({ mode: "only" }), imageExtension], {
    defaultTools: ["read", "codemode", "codex_generate_image"],
    sessionManager: SessionManager.open(sessionFile),
  });
  t.after(() => resumed.close());
  await resumed.session.prompt("/image-artifacts");
  assert.ok(JSON.stringify(resumed.session.messages.at(-1)).includes(first.path));
  const edit = await h.runInSession(resumed.session, "codemode",
    `text(await tools.codex_generate_image_artifact({prompt:"fixture edit",save:"none",numLastImagesToInclude:1}));`);
  assert.equal(edit.isError, false, JSON.stringify(edit.content));
  const record = resumed.sessionManager.getBranch().find(entry => entry.customType === ARTIFACT_ENTRY);
  assert.equal(record.data.artifact.path, first.path);
  assert.deepEqual(await readFile(first.path), PNG);
  assert.equal(h.imageRequests.length, 2);
  assert.equal(h.imageRequests[1].input[0].content[1].image_url, `data:image/png;base64,${PNG.toString("base64")}`);
  assert.deepEqual(resumed.errors, []);
  await unlink(first.path);
  resumed.sessionManager.branch(record.id);
  const missing = await h.runInSession(resumed.session, "codemode",
    `await tools.codex_generate_image_artifact({prompt:"fixture edit",save:"none",numLastImagesToInclude:1});`);
  assert.equal(missing.isError, true);
  assert.equal(h.imageRequests.length, 2);
});

test("hard script timeout after generation retains artifact metadata", async t => {
  const h = await fixture(t, "only", [pi => pi.registerTool({
    name: "fixture_wait", label: "Wait", description: "Wait fixture", parameters: Type.Object({}),
    execute(_id, _args, signal) {
      return new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  })]);
  const result = await h.script(`// @options: {"timeout_ms": 1000}
    await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});
    await tools.fixture_wait({});
  `);
  assert.equal(result.isError, true);
  assert.equal(h.imageRequests.length, 1);
  assert.equal(h.records().length, 1);
  assert.deepEqual(await readFile(h.records()[0].data.artifact.path), PNG);
});

for (const scenario of ["control", "navigation race", "session replacement", "reload"]) {
  test(`cancelled commit preserves originating-branch recovery (${scenario})`, async t => {
    const h = await fixture(t);
    const branchPoint = h.sessionManager.appendCustomEntry("fixture-origin", {});
    const probe = await open(join(h.root, "sync-probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const sync = prototype.sync;
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let gated = false;
    t.mock.method(prototype, "sync", async function (...args) {
      if (!gated) {
        gated = true;
        enter();
        await gate;
      }
      return sync.apply(this, args);
    });
    t.after(() => release());
    const pending = h.script(`await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});`);
    await entered; // Production writeFile finished; actual file sync is held.
    const reservation = h.sessionManager.getBranch().find(entry => entry.customType === RESERVATION_ENTRY);
    assert.ok(reservation);
    await h.session.abort();
    await pending;
    const originLeaf = h.sessionManager.getLeafId();
    const originSessionFile = h.sessionManager.getSessionFile();
    if (scenario === "session replacement") h.sessionManager.newSession();
    else if (scenario !== "control") h.sessionManager.branch(branchPoint);
    if (scenario === "reload") await h.session.reload();
    release();
    let ready;
    for (let attempt = 0; attempt < 200; attempt++) {
      ready = await readArtifactManifest(reservation.data);
      if (ready) break;
      await delay(10);
    }
    assert.ok(ready, "Completion manifest must become available without generation retry.");
    // Let the nested cleanup/optional same-branch completion entry settle.
    await delay(20);
    if (scenario === "control") h.sessionManager.branch(branchPoint);
    assert.equal((await branchArtifacts(h.sessionManager.getBranch())).length, 0);
    await h.session.prompt("/image-artifacts");
    assert.match(JSON.stringify(h.session.messages.at(-1)), /No image artifacts recorded/);
    if (scenario === "session replacement") h.sessionManager.setSessionFile(originSessionFile);
    h.sessionManager.branch(originLeaf);
    await h.session.reload();
    const recovered = await branchArtifacts(h.sessionManager.getBranch());
    assert.equal(recovered.length, 1);
    assert.deepEqual(await readFile(recovered[0].artifact.path), PNG);
    await h.session.prompt("/image-artifacts");
    assert.ok(JSON.stringify(h.session.messages.at(-1)).includes(ready.artifact.path));
    // A fork/resume that copies only the source branch retains the anchor;
    // recovery must not depend on completion entries elsewhere in the tree.
    const fork = h.sessionManager.createBranchedSession(originLeaf);
    assert.ok(fork);
    const restored = SessionManager.open(fork);
    assert.equal((await branchArtifacts(restored.getBranch())).length, 1);
    const edit = await h.script(`text(await tools.codex_generate_image_artifact({prompt:"fixture edit",save:"none",numLastImagesToInclude:1}));`);
    assert.equal(edit.isError, false, JSON.stringify(edit.content));
    assert.equal(h.imageRequests.length, 2);
    assert.equal(h.imageRequests[1].input[0].content[1].image_url, `data:image/png;base64,${PNG.toString("base64")}`);
    assert.deepEqual(h.errors, []);
  });
}

for (const failure of ["quota", "connection", "incomplete"]) {
  test(`artifact ${failure} failures never retry or retain empty reservations`, async t => {
    const h = await fixture(t);
    h.setImageHandler(() => {
      if (failure === "quota") return Response.json({ error: { code: "insufficient_quota" } }, { status: 429 });
      if (failure === "connection") throw new Error("fixture connection");
      return eventsResponse([{ type: "response.incomplete" }]);
    });
    const result = await h.script(`await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});`);
    assert.equal(result.isError, true);
    assert.equal(h.imageRequests.length, 1);
    assert.equal(h.records().length, 0);
    assert.equal((await readdir(h.root)).filter(name => name.startsWith("pi-codex-image-")).length, 0);
  });
}

test("artifact cancellation stops a stalled stream and cleans its reservation", async t => {
    const h = await fixture(t);
    let started;
    const requested = new Promise(resolve => { started = resolve; });
    let cancelled = false;
    h.setImageHandler(() => {
      started();
      return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }));
    });
    const pending = h.script(`await tools.codex_generate_image_artifact({prompt:"fixture",save:"none"});`);
    await requested;
    await new Promise(setImmediate); // Let the response reader attach before cancellation.
    await h.session.abort();
    await pending;
    assert.equal(cancelled, true);
    assert.equal(h.imageRequests.length, 1);
    assert.equal(h.records().length, 0);
    // Pi can finish the cancelled parent before the nested call's asynchronous
    // file close/remove settles. Bound the wait and assert eventual cleanup.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await readdir(h.root)).some(name => name.startsWith("pi-codex-image-"))) break;
      await delay(10);
    }
    assert.equal((await readdir(h.root)).filter(name => name.startsWith("pi-codex-image-")).length, 0);
  });
test("artifact network deadline fails once and cleans reserved storage", async t => {
  const root = await mkdtemp(join(tmpdir(), "artifact-deadline-"));
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(async () => {
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
    await rm(root, { recursive: true, force: true });
  });
  let tool;
  imageExtension({ registerProvider() {}, registerCommand() {}, appendEntry() {}, registerTool(value) {
    if (value.name === "codex_generate_image_artifact") tool = value;
  } });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requested;
  const requestStarted = new Promise(resolve => { requested = resolve; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; requested(); return new Response(new ReadableStream({ start() {} })); };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`;
  const pending = assert.rejects(tool.execute("fixture", { prompt: "fixture", save: "none" }, undefined, undefined, {
    cwd: root, isProjectTrusted: () => false,
    modelRegistry: { find: () => undefined, getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }) },
    sessionManager: { getSessionId: () => "fixture", getBranch: () => [], getLeafId: () => "fixture-origin" },
  }), /timed out after 5 minutes/);
  await requestStarted;
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await pending;
  assert.equal(calls, 1);
  assert.equal((await readdir(root)).length, 0);
});

test("private reservations clean only incomplete files; metadata rejects unsafe records", async t => {
  const root = await mkdtemp(join(tmpdir(), "image-reservation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pending = await reserveArtifact("png", root);
  await pending.dispose();
  assert.equal((await readdir(root)).length, 0);
  const completed = await reserveArtifact("png", root);
  const artifact = await completed.commit(PNG, "image/png");
  await completed.dispose();
  assert.deepEqual(await readFile(artifact.path), PNG);
  assert.equal(artifactRecord({ artifact, toolCallId: "fixture" }).artifact.path, artifact.path);
  for (const changes of [{ path: "../escape" }, { mimeType: "text/html" }, { byteCount: 33 * 1024 * 1024 }, { path: "/tmp/\nunsafe" }]) {
    assert.equal(artifactRecord({ artifact: { ...artifact, ...changes }, toolCallId: "fixture" }), undefined);
  }
  await assert.rejects(reserveArtifact("../escape", root), /Unsupported/);
  await assert.rejects(reserveArtifact("png", "/tmp/\nunsafe"), /unsupported/);
});

test("recovery manifests are bounded, validated, private, and reject symlinks", async t => {
  const root = await mkdtemp(join(tmpdir(), "artifact-manifest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pending = await reserveArtifact("png", root);
  const reservation = { path: pending.path, mimeType: "image/png", toolCallId: "fixture" };
  assert.equal(await readArtifactManifest(reservation), undefined);
  const artifact = await pending.commit(PNG, "image/png");
  await pending.publish({ artifact, toolCallId: "fixture" });
  await pending.dispose();
  assert.equal((await stat(`${pending.path}.json`)).mode & 0o777, 0o600);
  assert.equal((await readArtifactManifest(reservation)).artifact.path, artifact.path);
  assert.equal(await readArtifactManifest({ ...reservation, toolCallId: "other-call" }), undefined);
  const target = join(root, "manifest-target.json");
  await writeFile(target, await readFile(`${pending.path}.json`));
  await unlink(`${pending.path}.json`);
  await symlink(target, `${pending.path}.json`);
  assert.equal(await readArtifactManifest(reservation), undefined);
  await unlink(`${pending.path}.json`);
  await writeFile(`${pending.path}.json`, "x".repeat(8193));
  assert.equal(await readArtifactManifest(reservation), undefined);
  await writeFile(`${pending.path}.json`, JSON.stringify({ artifact: { ...artifact, mimeType: "text/html" }, toolCallId: "fixture" }));
  assert.equal(await readArtifactManifest(reservation), undefined);
});
