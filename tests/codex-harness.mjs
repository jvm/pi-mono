import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const testToken = [
  "test-header",
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64url"),
  "test-signature",
].join(".");

export function requestBody(init) {
  const body = new Headers(init.headers).get("content-encoding") === "zstd"
    ? zlib.zstdDecompressSync(init.body).toString("utf8")
    : init.body;
  return JSON.parse(body);
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
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth", access: testToken, refresh: "unused-fixture", expires: Date.now() + 3_600_000,
  }));
  const modelRuntime = await ModelRuntime.create({
    credentials, modelsPath: null, modelsStorePath: join(dir, "models-store.json"),
  });
  const model = modelRuntime.getModel("openai-codex", "gpt-6-astra");
  if (!model) throw new Error("Pi catalog has no Astra");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(dir);
  let api;
  let ctx;
  const errors = [];
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "Test assistant.",
    extensionFactories: [...factories, (pi) => {
      api = pi;
      pi.on("session_start", (_event, context) => { ctx = context; });
    }],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: dir, agentDir: dir, model, modelRuntime, sessionManager, settingsManager,
    resourceLoader: loader, thinkingLevel: "low",
  });
  if (extensionsResult.errors.length) throw new Error("Fixture extension load failed");
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  return {
    session, sessionManager, modelRuntime, model, api, ctx, errors,
    async close() { session.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}
