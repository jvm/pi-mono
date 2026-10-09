import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import imageExtension from "../packages/pi-codex-image-gen/extensions/index.ts";
import { IMAGE_AUTH_PROVIDER } from "../packages/pi-codex-image-gen/src/image-oauth.ts";
import { ARTIFACT_ENTRY } from "../packages/pi-codex-image-gen/src/artifacts.ts";
import goalExtension from "../packages/pi-goal/extensions/index.ts";
import { applyGoalMutation, createGoalMutation, statusMutation } from "../packages/pi-goal/src/state.ts";
import { GOAL_ENTRY_TYPE } from "../packages/pi-goal/src/types.ts";
import { codexHarness, requestBody, testToken, textResponse } from "./codex-harness.mjs";
import { eventsResponse, toolResponse, usage } from "./virtual-model-harness.mjs";

// Existing one-pixel fixture from the package's codemode tests. No generation.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const IMAGE_TOKEN = ["fixture-header", Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_image_fixture" },
})).toString("base64url"), "fixture-signature"].join(".");
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const PROBE_MODEL = {
  type: "image", provider: IMAGE_AUTH_PROVIDER, id: "fixture-native",
  name: "Test-only operation; not a served image model", api: "fixture-images",
  baseUrl: "https://fixture.invalid/images", input: ["text", "image"], output: ["text", "image"],
  // Synthetic metering only. These zeros are NOT a subscription price.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const PROBE_REF = { provider: PROBE_MODEL.provider, id: PROBE_MODEL.id };
export const INPUT = { input: [{ type: "text", text: "Use existing fixture bytes only." }] };
export const resultText = (result) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

export function imageResult(bytes = PNG, overrides = {}) {
  return {
    api: PROBE_MODEL.api, provider: PROBE_MODEL.provider, model: PROBE_MODEL.id,
    output: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }],
    responseId: "response_fixture", usage: usage(42), stopReason: "stop", timestamp: 0,
    ...overrides,
  };
}

export function backendResponse(bytes = PNG) {
  return eventsResponse([
    { type: "response.output_item.done", item: {
      type: "image_generation_call", id: "image_fixture", status: "completed",
      result: bytes.toString("base64"), size: "2048x2048", quality: "high",
    } },
    { type: "response.completed", response: {
      id: "response_fixture", usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 },
    } },
  ]);
}

const scopes = new WeakSet();

/** One isolated session per test context. Native registration is a probe, NOT an adapter. */
export async function nativeImageHarness(t, options = {}) {
  assert.ok(!scopes.has(t), "Use a separate test context for each fixture");
  scopes.add(t);
  const root = await mkdtemp(join(tmpdir(), "pi-native-images-"));
  const environment = {
    HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: join(root, "agent"),
    CI: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
    PI_CODEX_IMAGE_SAVE_MODE: undefined, PI_CODEX_IMAGE_SAVE_DIR: undefined,
  };
  const savedEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  let h;
  // Each global is mocked exactly once. Even failed setup restores the environment.
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(h, "Network is blocked during setup");
    assert.equal(String(url), RESPONSES_URL, "Unmocked endpoint blocked");
    assert.ok(h.chatRequests.length + h.imageRequests.length < 30, "Request limit");
    const body = requestBody(init);
    const image = body.tools?.some(tool => tool.type === "image_generation");
    if (image) h.imageAttempts++;
    const expectedToken = image && (options.owned ?? "oauth") !== "absent" ? IMAGE_TOKEN : testToken;
    assert.ok(new Headers(init.headers).get("authorization") === `Bearer ${expectedToken}`, "Only fixture credentials may be used");
    if (image) {
      assert.equal(init.redirect, "error");
      h.imageRequests.push(body);
      return h.backend(body, init);
    }
    h.chatRequests.push(body);
    const call = h.nextCall;
    h.nextCall = undefined;
    return call ? toolResponse(call.name, call.args, body) : textResponse();
  });
  t.mock.method(globalThis, "WebSocket", function () { throw new Error("WebSocket network blocked"); });
  t.after(async () => {
    try {
      if (h) { await h.session.abort(); await h.close(); }
      await rm(root, { recursive: true, force: true });
    } finally {
      for (const [key, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth", access: testToken, refresh: "fixture-unused", expires: Date.now() + 3_600_000,
  }));
  if ((options.owned ?? "oauth") !== "absent") {
    await credentials.modify(IMAGE_AUTH_PROVIDER, async () => options.owned === "api-key"
      ? { type: "api_key", key: "fixture-not-oauth" }
      : { type: "oauth", access: options.owned === "invalid-oauth" ? "fixture-invalid-oauth" : IMAGE_TOKEN,
        refresh: "fixture-unused", expires: Date.now() + 3_600_000 });
  }
  const modelRuntime = await ModelRuntime.create({
    credentials, modelsPath: null, modelsStorePath: join(root, "models-store.json"),
  });
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  const goal = createGoalMutation("Offline native-image contract investigation");
  sessionManager.appendCustomEntry(GOAL_ENTRY_TYPE, goal);
  sessionManager.appendCustomEntry(GOAL_ENTRY_TYPE, statusMutation(applyGoalMutation(null, goal), "paused", 0));
  const nativeCalls = [];
  const toolCalls = [];
  const toolResults = [];
  const imageFactory = (pi) => imageExtension({
    ...pi,
    registerProvider(provider) {
      assert.equal(provider.id, IMAGE_AUTH_PROVIDER);
      pi.registerProvider(options.native === false ? provider : {
        ...provider,
        getModels: () => [PROBE_MODEL],
        async generateImages(model, context, requestOptions) {
          const key = requestOptions?.apiKey;
          assert.ok(key === IMAGE_TOKEN || key === "fixture-not-oauth", "Unexpected fixture credential");
          nativeCalls.push({
            model, context, signal: requestOptions?.signal, metadata: requestOptions?.metadata,
            headers: requestOptions?.headers, oauth: key === IMAGE_TOKEN,
          });
          return h.generate(model, context, requestOptions);
        },
      });
    },
  });
  const session = await codexHarness([
    createCodemodeExtension({ mode: options.mode ?? "only" }), imageFactory, goalExtension,
    ...(options.factories ?? []),
    pi => {
      pi.on("tool_call", event => {
        toolCalls.push({ name: event.toolName, parent: event.parentToolCallId });
        if (["codemode", "codex_generate_image", "codex_generate_image_artifact", "fixture_image_wrapper"].includes(event.toolName)) return;
        if (event.toolName === "read" && resolve(event.input.path).startsWith(root + sep)) return;
        return { block: true, reason: "OS tools are disabled in the native-image fixture" };
      });
      pi.on("tool_result", event => toolResults.push(event));
    },
  ], {
    modelRuntime, sessionManager, cwd: root,
    defaultTools: ["codemode", "codex_generate_image", "read", "fixture_image_wrapper"],
    excludeTools: options.excludeTools,
  });
  h = {
    ...session, root, credentials, nativeCalls, toolCalls, toolResults,
    chatRequests: [], imageRequests: [], imageAttempts: 0, nextCall: undefined,
    generate: () => imageResult(), backend: () => backendResponse(),
    records: () => sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === ARTIFACT_ENTRY),
    async imageFiles() {
      return (await readdir(root, { recursive: true })).filter(path => /\.(png|jpg|webp)$/.test(path));
    },
    async run(name, args) {
      assert.equal(h.nextCall, undefined, "No concurrent scripts in this fixture");
      h.nextCall = { name, args };
      await h.session.prompt("Offline fixture only; no real generation or credentials.");
      assert.deepEqual(h.errors, []);
      return h.session.messages.findLast(message => message.role === "toolResult");
    },
    script(code) { return h.run("codemode", { code }); },
  };
  return h;
}
