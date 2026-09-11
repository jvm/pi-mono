import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from "../.test-dist/src/codex-response.js";

import extension, {
  abortableDelay,
  buildRequestBody,
  decodeImageData,
  parseRetryAfter,
  resolveInputImages,
  retryDelayMs,
  selectRecentImages,
} from "../.test-dist/extensions/index.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);

function jwt() {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url");
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${payload}.signature`;
}

function sseResponse(image = PNG.toString("base64")) {
  const events = [
    { type: "response.created", response: { id: "response-1" } },
    { type: "response.output_item.done", item: { type: "image_generation_call", id: "image-1", status: "completed", result: image } },
    { type: "response.completed", response: { id: "response-1", usage: { total_tokens: 1 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createTool() {
  let tool;
  extension({
    registerTool(value) { tool = value; },
  });
  assert.ok(tool);
  return tool;
}

function context(cwd, messages = []) {
  return {
    cwd,
    isProjectTrusted: () => false,
    modelRegistry: {
      find: () => undefined,
      getApiKeyForProvider: async () => jwt(),
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => messages.map((message) => ({ type: "message", message })),
    },
  };
}

test("strict image decoding accepts matching formats", () => {
  assert.deepEqual(decodeImageData(PNG.toString("base64"), "png"), PNG);
  assert.deepEqual(decodeImageData(JPEG.toString("base64"), "jpeg"), JPEG);
  assert.deepEqual(decodeImageData(WEBP.toString("base64"), "webp"), WEBP);
});

test("strict image decoding rejects malformed, truncated, empty, and mismatched data without exposing payload", () => {
  for (const value of ["", "!!!!", "aGVsbG8", "AAAA=A=="]) {
    assert.throws(() => decodeImageData(value, "png"), /invalid base64 image data/);
  }
  assert.throws(() => decodeImageData(Buffer.from("not an image").toString("base64"), "png"), /does not match png/);
  try {
    decodeImageData("SECRET!!!!", "png");
  } catch (error) {
    assert.doesNotMatch(error.message, /SECRET/);
  }
});

test("Retry-After supports seconds and HTTP dates with bounded deterministic jitter", () => {
  const now = Date.parse("2026-07-14T00:00:00Z");
  assert.equal(parseRetryAfter("2", now), 2000);
  assert.equal(parseRetryAfter("Tue, 14 Jul 2026 00:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("999", now), 30000);
  assert.equal(parseRetryAfter("invalid", now), undefined);
  assert.equal(retryDelayMs(2, null, () => 0, now), 1800);
  assert.equal(retryDelayMs(1, "2", () => 1, now), 2200);
});

test("abortable retry delay stops promptly", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const delayed = abortableDelay(10_000, controller.signal);
  controller.abort();
  await assert.rejects(delayed, /aborted/);
  assert.ok(Date.now() - started < 500);
});

test("local edit images resolve, preserve order, and enter the request", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-edit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "one.png"), PNG);
  await writeFile(join(cwd, "two.jpg"), JPEG);
  const params = { prompt: "edit", referencedImagePaths: ["one.png", "@two.jpg"] };
  const images = await resolveInputImages(params, cwd, []);
  assert.deepEqual(images.map((image) => image.mimeType), ["image/png", "image/jpeg"]);
  const body = buildRequestBody(params, "gpt-5.5", "png", "session", images);
  assert.deepEqual(body.input[0].content.map((part) => part.type), ["input_text", "input_image", "input_image"]);
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
});

test("edit selectors enforce conflicts, limits, missing paths, and recent image availability", async () => {
  await assert.rejects(resolveInputImages({ prompt: "x", referencedImagePaths: ["x"], numLastImagesToInclude: 1 }, "/tmp", []), /only one/);
  await assert.rejects(resolveInputImages({ prompt: "x", referencedImagePaths: Array(6).fill("x") }, "/tmp", []), /at most 5/);
  await assert.rejects(resolveInputImages({ prompt: "x", referencedImagePaths: ["missing.png"] }, "/tmp", []), /Unable to read/);
  await assert.rejects(resolveInputImages({ prompt: "x", numLastImagesToInclude: 2 }, "/tmp", [{ content: [{ type: "image", data: "a", mimeType: "image/png" }] }]), /only 1/);
});

test("recent images are selected newest-first then returned chronologically", () => {
  const messages = [
    { content: [{ type: "image", data: "old", mimeType: "image/png" }] },
    { content: [{ type: "image", data: "new-1", mimeType: "image/png" }, { type: "image", data: "new-2", mimeType: "image/png" }] },
  ];
  assert.deepEqual(selectRecentImages(messages, 2).map((image) => image.data), ["new-1", "new-2"]);
});

test("tool edit request includes local image content", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-tool-edit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "source.png"), PNG);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return sseResponse();
  };
  const result = await createTool().execute("call", { prompt: "edit", referencedImagePaths: ["source.png"], save: "none" }, undefined, undefined, context(cwd));
  assert.equal(result.details.inputImageCount, 1);
  assert.equal(requestBody.input[0].content[1].type, "input_image");
});

test("tool leaves image model selection to Codex and does not claim a model ID", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-model-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return sseResponse();
  };
  const tool = createTool();
  const updates = [];
  const result = await tool.execute("call", { prompt: "test", save: "none" }, undefined,
    (update) => updates.push(update), context(cwd));
  assert.equal(body.model, "gpt-5.5");
  assert.deepEqual(body.tools, [{ type: "image_generation", output_format: "png" }]);
  assert.equal(result.details.backendImageModel, "unknown");
  assert.doesNotMatch(JSON.stringify([tool.description, tool.promptSnippet, updates, result]), /gpt-image-/);
});

test("retry loop honors Retry-After and remains bounded", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-retry-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("overloaded", { status: 503, headers: { "retry-after": "0" } })
      : sseResponse();
  };
  await createTool().execute("call", { prompt: "test", save: "none" }, undefined, undefined, context(cwd));
  assert.equal(calls, 2);
});

test("aborting during retry backoff prevents another request", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-retry-abort-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("overloaded", { status: 503, headers: { "retry-after": "10" } });
  };
  const controller = new AbortController();
  const execution = createTool().execute("call", { prompt: "test", save: "none" }, controller.signal, undefined, context(cwd));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(execution, /aborted/);
  assert.equal(calls, 1);
});

test("successful generation saves validated bytes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-save-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => sseResponse();
  const result = await createTool().execute("call", { prompt: "test", save: "custom", saveDir: "out" }, undefined, undefined, context(cwd));
  assert.equal(result.details.inputImageCount, 0);
  assert.equal(result.details.saveWarning, undefined);
  assert.deepEqual(await readFile(result.details.savedPath), PNG);
});

test("disk save failure still returns the validated inline image and warning", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-save-fail-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const blocker = join(cwd, "not-a-directory");
  await writeFile(blocker, "block");
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => sseResponse();
  const result = await createTool().execute("call", { prompt: "test", save: "custom", saveDir: blocker }, undefined, undefined, context(cwd));
  assert.equal(result.details.savedPath, undefined);
  assert.match(result.details.attemptedPath, /not-a-directory/);
  assert.match(result.details.saveWarning, /could not be saved/);
  assert.equal(result.content.find((part) => part.type === "image").data, PNG.toString("base64"));
});

test("malformed backend payload fails before saving or returning image content", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-invalid-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => sseResponse("!!!!");
  await assert.rejects(createTool().execute("call", { prompt: "test", save: "custom", saveDir: "out" }, undefined, undefined, context(cwd)), /invalid base64/);
  await assert.rejects(readFile(join(cwd, "out", "session-1", "image-1.png")));
});

async function harness(t, responder) {
  const cwd = await mkdtemp(join(tmpdir(), "imagegen-contract-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    return responder(url, init);
  };
  const tool = createTool();
  return {
    cwd, calls, tool,
    run: (params = {}, signal, onUpdate, ctx = context(cwd)) =>
      tool.execute("call", { prompt: "test", save: "none", ...params }, signal, onUpdate, ctx),
  };
}

function imageEvent(extra = {}) {
  return { type: "response.output_item.done", item: {
    type: "image_generation_call", id: "image-1", status: "completed", result: PNG.toString("base64"), ...extra,
  } };
}

function streamEvents(events, { crlf = false, fragment = false, close = true, cancel = () => {} } = {}) {
  const newline = crlf ? "\r\n" : "\n";
  const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join(""));
  return new Response(new ReadableStream({
    start(controller) {
      if (fragment) for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1));
      else controller.enqueue(bytes);
      if (close) controller.close();
    },
    cancel,
  }));
}

test("tool sends an honest Pi User-Agent, blocks redirects, and retains the subscription route", async (t) => {
  const h = await harness(t, () => sseResponse());
  await h.run();
  assert.equal(h.calls[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(h.calls[0].headers["User-Agent"], "pi-codex-image-gen");
  assert.equal(h.calls[0].headers.originator, "pi");
  assert.equal(h.calls[0].redirect, "error");
  assert.ok(h.calls[0].signal instanceof AbortSignal);
});

test("tool handles fragmented CRLF events and reports backend metadata and progress", async (t) => {
  let cancelled = false;
  const h = await harness(t, () => streamEvents([
    { type: "response.image_generation_call.in_progress" },
    { type: "response.image_generation_call.generating" },
    imageEvent({ size: "1254x1254", quality: "low", background: "opaque", output_format: "png" }),
    { type: "response.completed", response: { usage: {
      total_tokens: 10, input_tokens_details: { cached_tokens: 4 }, private_data: "DO_NOT_COPY",
    } } },
  ], { crlf: true, fragment: true, close: false, cancel: () => { cancelled = true; } }));
  const updates = [];
  const result = await h.run({}, undefined, update => updates.push(update));
  assert.deepEqual(result.details.reportedImage, {
    size: "1254x1254", quality: "low", background: "opaque", outputFormat: "png",
  });
  assert.equal(result.details.backendImageModel, "unknown");
  assert.equal(result.details.byteCount, PNG.length);
  assert.match(result.content[0].text, /Backend-reported size: 1254x1254/);
  assert.ok(updates.some(update => update.details?.stage === "generating"));
  assert.deepEqual(result.details.usage, { total_tokens: 10, input_tokens_details: { cached_tokens: 4 } });
  assert.equal(cancelled, true);
});

test("tool accepts completion-only image output and only records a model when explicitly reported", async (t) => {
  const h = await harness(t, () => streamEvents([
    { type: "response.completed", response: { output: [
      imageEvent({ model: "gpt-image-2.5-flare", background: "transparent" }).item,
    ] } },
  ]));
  const result = await h.run();
  assert.equal(result.details.backendImageModel, "gpt-image-2.5-flare");
  assert.equal(result.details.reportedImage.background, "transparent");
});

test("tool rejects incomplete, failed, malformed, and multiple-image streams without retrying", async (t) => {
  for (const events of [
    [imageEvent()],
    [imageEvent(), { type: "response.incomplete" }],
    [imageEvent({ status: "failed" }), { type: "response.completed" }],
    [imageEvent(), imageEvent({ id: "image-2" }), { type: "response.completed" }],
    [{ type: "error", message: jwt() }],
  ]) {
    await t.test(JSON.stringify(events.map(event => event.type)), async (t) => {
      const h = await harness(t, () => streamEvents(events));
      await assert.rejects(h.run(), error => !error.message.includes(jwt()));
      assert.equal(h.calls.length, 1);
    });
  }
  const h = await harness(t, () => new Response(`data: invalid-${jwt()}\n\n`));
  await assert.rejects(h.run(), error => /invalid stream event/.test(error.message) && !error.message.includes(jwt()));
  assert.equal(h.calls.length, 1);
});

test("tool classifies Cloudflare, auth, quota, and moderation failures without exposing response bodies", async (t) => {
  for (const [status, error, headers, message] of [
    [403, "PRIVATE_HTML", { "cf-mitigated": "challenge" }, /Cloudflare/],
    [401, "PRIVATE_AUTH", {}, /login/],
    [429, { error: { code: "insufficient_quota", message: jwt() } }, {}, /quota/],
    [429, { error: { type: "usage_limit_reached", message: jwt() } }, {}, /quota/],
    [429, { error: { type: "image_generation_user_error", message: jwt() } }, {}, /Review the prompt/],
  ]) {
    await t.test(String(status) + String(message), async (t) => {
      const h = await harness(t, () => new Response(JSON.stringify(error), { status, headers }));
      await assert.rejects(h.run(), failure =>
        message.test(failure.message) && !failure.message.includes(jwt()) && !failure.message.includes("PRIVATE_"));
      assert.equal(h.calls.length, 1);
    });
  }
});

test("tool bounds error bodies and never echoes network exceptions", async (t) => {
  let cancelled = false;
  const h = await harness(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from("PRIVATE_BODY".repeat(2000))); },
    cancel() { cancelled = true; },
  }), { status: 401 }));
  await assert.rejects(h.run(), error => /401/.test(error.message) && !error.message.includes("PRIVATE_BODY"));
  assert.equal(cancelled, true);
  globalThis.fetch = async () => { throw new Error(jwt()); };
  await assert.rejects(h.run(), error => /connection failed/.test(error.message) && !error.message.includes(jwt()));
});

test("tool rejects oversized streams from both declared length and streamed byte count", async (t) => {
  const h = await harness(t, () => new Response("", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
  await assert.rejects(h.run(), /size limit/);
  let cancelled = false;
  const block = Buffer.from(":" + "x".repeat(1024 * 1024) + "\n\n");
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(block); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(h.run(), /size limit/);
  assert.equal(cancelled, true);
});

test("tool deadline aborts both a pending connection and a stalled stream", async (t) => {
  for (const stalledStream of [false, true]) {
    await t.test(stalledStream ? "stream" : "connection", async (t) => {
      const h = await harness(t, () => stalledStream
        ? new Response(new ReadableStream({ start() {} }))
        : new Promise(() => {}));
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const rejected = assert.rejects(h.run(), /timed out after 5 minutes/);
      await new Promise(setImmediate);
      t.mock.timers.tick(REQUEST_TIMEOUT_MS);
      await rejected;
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].signal.aborted, true);
    });
  }
});

test("tool cancellation interrupts a stalled stream without another generation", async (t) => {
  let cancelled = false;
  const h = await harness(t, () => new Response(new ReadableStream({
    start() {},
    cancel() { cancelled = true; },
  })));
  const controller = new AbortController();
  const rejected = assert.rejects(h.run({}, controller.signal), /aborted/);
  await new Promise(setImmediate);
  controller.abort();
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 1);
});

test("tool withholds stream exceptions and does not retry an interrupted response", async (t) => {
  const h = await harness(t, () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(jwt())); },
  })));
  await assert.rejects(h.run(), error => /stream was interrupted/.test(error.message) && !error.message.includes(jwt()));
  assert.equal(h.calls.length, 1);
});

test("tool validates save settings, routing model, prompts, and input files before generating", async (t) => {
  const h = await harness(t, () => { throw new Error("Must not call backend"); });
  await assert.rejects(h.run({ save: "custom", saveDir: "" }), /save=custom/);
  await assert.rejects(h.run({ model: "gpt-image-2.5-flare" }), /routing model/);
  await assert.rejects(h.run({ prompt: "x".repeat(32001) }), /32,000/);
  const large = join(h.cwd, "large.png");
  const file = await open(large, "w");
  await file.truncate(20 * 1024 * 1024 + 1);
  await file.close();
  await assert.rejects(h.run({ referencedImagePaths: [large] }), /20 MiB/);
  await assert.rejects(h.run({ referencedImagePaths: [h.cwd] }), /regular files/);
  await assert.rejects(h.run({ numLastImagesToInclude: 1 }, undefined, undefined,
    context(h.cwd, [{ content: [{ type: "image", mimeType: "image/png", data: "!!!!" }] }])), /invalid base64/);
  assert.equal(h.calls.length, 0);
});

test("tool redacts credentials from revised prompts and split response text", async (t) => {
  const h = await harness(t, () => streamEvents([
    imageEvent({ revised_prompt: `Prompt ${jwt()}`, id: jwt() }),
    { type: "response.completed" },
  ]));
  assert.doesNotMatch(JSON.stringify(await h.run()), new RegExp(jwt().replaceAll(".", "\\.")));
  globalThis.fetch = async () => streamEvents([
    { type: "response.output_text.delta", delta: jwt().slice(0, 20) },
    { type: "response.output_text.delta", delta: jwt().slice(20) },
    { type: "response.completed" },
  ]);
  await assert.rejects(h.run(), error => !error.message.includes(jwt()));
  globalThis.fetch = async () => streamEvents([
    { type: "response.output_text.delta", delta: "x".repeat(3980) + " " + jwt() },
    { type: "response.completed" },
  ]);
  await assert.rejects(h.run(), error => !error.message.includes(jwt().slice(0, 15)));
});

test("tool enforces decoded reference and output image limits", async (t) => {
  const h = await harness(t, () => { throw new Error("Must not generate"); });
  // This count shares the same base64 length as the maximum accepted input,
  // so a pre-decode length check alone is not sufficient.
  const input = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 + 1 - PNG.length)]);
  await assert.rejects(h.run({ numLastImagesToInclude: 1 }, undefined, undefined,
    context(h.cwd, [{ content: [{ type: "image", mimeType: "image/png", data: input.toString("base64") }] }])), /20 MiB/);
  assert.equal(h.calls.length, 0);
  globalThis.fetch = async () => streamEvents([
    imageEvent({ result: "A".repeat(Math.ceil(32 * 1024 * 1024 / 3) * 4 + 4) }),
    { type: "response.completed" },
  ]);
  await assert.rejects(h.run(), /32 MiB/);
});

test("tool preserves an existing image on a repeated backend image ID", async (t) => {
  const h = await harness(t, () => sseResponse());
  const first = await h.run({ save: "custom", saveDir: "out" });
  await writeFile(first.details.savedPath, "USER_IMAGE");
  const second = await h.run({ save: "custom", saveDir: "out" });
  assert.match(second.details.saveWarning, /could not be saved/);
  assert.equal(await readFile(first.details.savedPath, "utf8"), "USER_IMAGE");
  assert.equal(second.content[1].type, "image");
});
