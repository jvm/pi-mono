import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, isAbsolute } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const hostPath = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
export const hostVersion = JSON.parse(readFileSync(join(dirname(hostPath), "..", "package.json"), "utf8")).version;
if (process.env.PI_TEST_HOST_VERSION) {
  for (const specifier of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
    const path = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
    const version = JSON.parse(readFileSync(join(dirname(path), "..", "package.json"), "utf8")).version;
    assert.equal(version, process.env.PI_TEST_HOST_VERSION, `Wrong ${specifier} loaded from ${path}`);
    const location = relative(realpathSync(process.env.PI_TEST_HOST_ROOT), path);
    assert.ok(!location.startsWith("..") && !isAbsolute(location), `Host dependency escaped isolated lane: ${path}`);
  }
}
console.log(`Pi compatibility host ${hostVersion}: ${dirname(hostPath)}`);

export const testToken = [
  "test-header",
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64url"),
  "test-signature",
].join(".");

export function requestBody(init) {
  const body = new Headers(init.headers).get("content-encoding") === "zstd"
    ? zlib.zstdDecompressSync(init.body).toString("utf8")
    : init.body;
  const parsed = JSON.parse(body);
  // 1.4 serializes declarations as chronological additional_tools items.
  // Keep those items intact for ordering tests; expose the historical catalog
  // for fixtures that emit call shapes. Removals are text notices on this
  // transport, not erased schemas: tests must check active/callable state too.
  if (!parsed.tools) parsed.tools = [...new Map((parsed.input ?? [])
    .filter(item => item.type === "additional_tools")
    .flatMap(item => item.tools ?? []).map(tool => [tool.name, tool])).values()];
  return parsed;
}

export function compactionResponse(usage = {}) {
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "fixture-checkpoint" } })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}`,
    "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}

export function textResponse(text = "OK") {
  const item = {
    type: "message", id: "msg_fixture", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return new Response([
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Real Pi loader, event runner, tool registry, provider serializer and session tree. */
export async function codexHarness(factories, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-contract-"));
  const cwd = options.cwd ?? dir;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth", access: testToken, refresh: "unused-fixture", expires: Date.now() + 3_600_000,
  }));
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
    credentials, modelsPath: null, modelsStorePath: join(dir, "models-store.json"),
  });
  const model = modelRuntime.getModel("openai-codex", "gpt-6-astra");
  if (!model) throw new Error("Pi catalog has no Astra");
  const settingsManager = SettingsManager.inMemory({
    // Fixtures mock fetch, not WebSocket. Never attempt the live WS transport
    // before falling back to the mocked SSE response.
    transport: "sse",
    ...(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
    compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 1 },
    retry: options.retry ?? { enabled: false },
  });
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
  let api;
  let ctx;
  const errors = [];
  const loader = new DefaultResourceLoader({
    cwd, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    ...(options.skills ? { skillsOverride: () => ({ skills: options.skills, diagnostics: [] }) } : {}),
    systemPromptOverride: () => "Test assistant.",
    extensionFactories: [...factories, (pi) => {
      api = pi;
      pi.on("session_start", (_event, context) => { ctx = context; });
    }],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd, agentDir: dir, model, modelRuntime, sessionManager, settingsManager,
    resourceLoader: loader, thinkingLevel: "low",
    sessionStartEvent: options.sessionStartEvent,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
  });
  if (extensionsResult.errors.length) throw new Error("Fixture extension load failed");
  await session.bindExtensions({ mode: "print", ...options.bindings, onError: (error) => errors.push(error) });
  session.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage) {
      console.error(`Fixture provider failure: ${event.message.errorMessage}`);
    }
  });
  return {
    session, sessionManager, modelRuntime, model, api, ctx, errors,
    async close() { session.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}
