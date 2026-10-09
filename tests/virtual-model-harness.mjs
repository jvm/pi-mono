import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { requestBody, testToken, textResponse } from "./codex-harness.mjs";
import { applyGoalMutation, createGoalMutation, reconstructGoalState, statusMutation } from "../packages/pi-goal/src/state.ts";
import { GOAL_ENTRY_TYPE } from "../packages/pi-goal/src/types.ts";

export const usage = (tokens) => ({
  input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function eventsResponse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export function toolResponse(name, args, request) {
  const declaration = request.tools?.find((tool) => tool.name === name);
  const item = declaration?.type === "custom"
    ? { type: "custom_tool_call", id: "ct_fixture", call_id: "call_fixture", name, input: args.code }
    : { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name, arguments: JSON.stringify(args) };
  return eventsResponse([
    { type: "response.output_item.added", output_index: 0, item: {
      ...item, ...(item.type === "function_call" ? { arguments: "" } : { input: "" }),
    } },
    item.type === "function_call"
      ? { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments }
      : { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: item.id, delta: item.input },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: {
      status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    } },
  ]);
}

function chatResponse() {
  const chunk = (choices, metering) => ({
    id: "chat_fixture", object: "chat.completion.chunk", created: 0, model: "tiny",
    choices, ...(metering ? { usage: metering } : {}),
  });
  const chunks = [
    chunk([{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
    chunk([], { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
  ];
  return new Response(`${chunks.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

export const goalState = (h) => reconstructGoalState(h.sessionManager.getBranch());
export const lastAssistant = (h) => h.session.messages.findLast((message) => message.role === "assistant");
export const routingEntries = (h) => h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state");
const scopes = new WeakMap();

/** No live network, real credentials, user configuration, or executable OS tools. */
export async function virtualHarness(t, factories, options = {}) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network blocked"); });
  t.mock.method(globalThis, "WebSocket", function () { throw new Error("WebSocket network blocked"); });
  const dir = await mkdtemp(join(tmpdir(), "pi-virtual-contract-"));
  const environment = {
    HOME: dir, PI_CODING_AGENT_DIR: dir, CI: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
  };
  let scope = scopes.get(t);
  if (!scope) {
    scope = { sessions: [], directories: [] };
    scopes.set(t, scope);
    const savedEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    t.after(async () => {
      try {
        for (const session of scope.sessions.reverse()) session.dispose();
        for (const directory of scope.directories.reverse()) await rm(directory, { recursive: true, force: true });
      } finally {
        for (const [key, value] of Object.entries(savedEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }
  scope.directories.push(dir);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-public-key" }));
  await credentials.modify("openai-codex", async () => ({
    type: "oauth", access: testToken, refresh: "unused-fixture", expires: Date.now() + 3_600_000,
  }));
  const modelRuntime = await ModelRuntime.create({
    credentials, modelsPath: null, modelsStorePath: join(dir, "models-store.json"),
  });
  const settingsManager = SettingsManager.inMemory({
    transport: "sse", compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 1 },
    retry: options.retry ?? { enabled: false }, ...options.settings,
  });
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(dir);
  if (!options.sessionManager) {
    const mutation = createGoalMutation("Synthetic virtual-model fixture");
    sessionManager.appendCustomEntry(GOAL_ENTRY_TYPE, mutation);
    sessionManager.appendCustomEntry(GOAL_ENTRY_TYPE, statusMutation(applyGoalMutation(null, mutation), "paused", 0));
  }
  const h = {
    modelRuntime, sessionManager, requests: [], routes: [], hooks: [], streams: [], errors: [],
    target: "public", replies: [], provider: options.provider ?? "fixture-router",
    modelId: options.modelId ?? "auto",
  };
  const definitions = (pi) => {
    pi.registerProvider("fixture-foreign", {
      api: "openai-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic-foreign-key",
      models: [{
        id: "tiny", name: "Small unsupported fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
      }],
    });
    pi.registerVirtualModel({
      provider: h.provider, id: h.modelId, name: "Astra-looking fixture; not a physical model",
      thinkingLevels: ["off", "low", "high"],
      route: async (request, ctx) => {
        h.routes.push({
          reason: request.reason, state: structuredClone(request.state), previous: request.previous,
          failed: request.failed, selected: ctx.model, thinkingLevel: request.thinkingLevel,
        });
        if (options.route) return options.route(request, ctx, h);
        const model = request.reason === "continuation" ? request.previous?.model
          : request.reason === "retry" ? request.failed?.model : undefined;
        return {
          model: model ?? h.physical(h.target), thinkingLevel: "low",
          state: { visits: (request.state?.visits ?? 0) + 1, target: h.target },
        };
      },
    });
    pi.on("before_provider_request", (_event, ctx) => { h.hooks.push(ctx.model); });
    pi.on("provider_stream_event", (event) => {
      // Record only synthetic identity, not provider stream payloads.
      h.streams.push({ provider: event.provider, api: event.api, model: event.model });
    });
    pi.on("tool_call", (event) => {
      if (["read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls"].includes(event.toolName)) {
        return { block: true, reason: "OS tool execution is disabled in this fixture" };
      }
    });
    pi.on("session_start", (_event, ctx) => { h.ctx = ctx; });
  };
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Synthetic offline routing fixture.",
    extensionFactories: [definitions, ...factories],
  });
  await loader.reload();
  const result = await createAgentSession({
    cwd: dir, agentDir: dir, model: modelRuntime.getModel("openai", "gpt-6-astra"),
    modelRuntime, sessionManager, settingsManager, resourceLoader: loader,
    thinkingLevel: "low", ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
  });
  const session = result.session;
  scope.sessions.push(session);
  h.session = session;
  assert.deepEqual(result.extensionsResult.errors, []);
  h.physical = (target) => {
    const [provider, id] = {
      public: ["openai", "gpt-6-astra"], codex: ["openai-codex", "gpt-6-astra"], foreign: ["fixture-foreign", "tiny"],
    }[target];
    const model = modelRuntime.getModel(provider, id);
    assert.ok(model, `missing physical fixture ${target}`);
    return model;
  };
  await session.bindExtensions({ mode: "print", onError: (error) => h.errors.push(error) });
  h.selectVirtual = async () => {
    const model = modelRuntime.getModel(h.provider, h.modelId);
    assert.ok(model, "virtual definition registered");
    await session.setModel(model);
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(h.requests.length < 30, "bounded synthetic provider calls");
    const target = new URL(String(url));
    assert.ok(["api.openai.com", "chatgpt.com", "fixture.invalid"].includes(target.hostname), "unexpected fixture URL");
    const expectedKey = target.hostname === "api.openai.com" ? "synthetic-public-key"
      : target.hostname === "chatgpt.com" ? testToken : "synthetic-foreign-key";
    assert.ok(new Headers(init.headers).get("authorization") === `Bearer ${expectedKey}`, "only the physical provider's fixture credential may be sent");
    const body = requestBody(init);
    h.requests.push(body);
    const reply = h.replies.shift();
    if (reply) return reply(body, init);
    return target.hostname === "fixture.invalid" ? chatResponse() : textResponse();
  });
  return h;
}
