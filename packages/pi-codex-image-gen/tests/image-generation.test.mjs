import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  return `header.${payload}.signature`;
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
