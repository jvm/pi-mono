// Optional SDK compatibility smoke: pass another installed host's dist/index.js.
// Uses synthetic credentials/provider responses; never reads user credentials.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import piProcesses from "../extensions/index.ts";
import { requestBody, testToken, textResponse } from "../../../tests/codex-harness.mjs";

if (!process.argv[2]) throw new Error("Pass the installed host's dist/index.js path");
const host = await import(pathToFileURL(resolve(process.argv[2])).href);
const dir = await mkdtemp(join(tmpdir(), "pi-processes-host-smoke-"));
const fetch = globalThis.fetch;
const keys = ["CI", "PI_OFFLINE", "PI_TELEMETRY", "PI_CODING_AGENT_DIR"];
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
Object.assign(process.env, { CI: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: dir });
let session;
let calls = 0;
const requests = [];
const errors = [];

try {
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) throw new Error("Unmocked network blocked");
    const body = requestBody(init);
    assert.ok(Array.isArray(body.input), "only synthetic inference is permitted");
    requests.push(body);
    if (calls++) return textResponse("Smoke result handled.");
    const script = `
      const ordinary=await tools.bash({command:"printf ordinary"});
      if (ordinary.output !== "ordinary") throw new Error("Built-in bash result changed");
      const job=await tools.bash({command:"sleep 0.1; seq 1 100",mode:"background",title:"Background smoke"});
      await tools.bash({command:"sleep 0.3; printf independent",mode:"foreground"});
      text({session_id:job.session_id});`;
    const tools = [...(body.tools ?? []),
      ...body.input.flatMap(item => item.type === "additional_tools" ? item.tools : [])];
    const custom = tools.find(t => t.name === "codemode")?.type === "custom";
    const args = custom ? script : JSON.stringify({ code: script });
    const item = custom
      ? { type: "custom_tool_call", id: "ct_smoke", call_id: "call_smoke", name: "codemode", input: args }
      : { type: "function_call", id: "fc_smoke", call_id: "call_smoke", name: "codemode", arguments: args };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, ...(custom ? { input: "" } : { arguments: "" }) } },
      { type: custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
        output_index: 0, item_id: item.id, delta: args },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1 } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth", access: testToken, refresh: "unused-fixture", expires: Date.now() + 3_600_000,
  }));
  const modelRuntime = await host.ModelRuntime.create({
    credentials, modelsPath: null, modelsStorePath: join(dir, "models.json"),
  });
  const settingsManager = host.SettingsManager.inMemory({
    transport: "sse", defaultTools: ["bash", "codemode"],
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const loader = new host.DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPromptOverride: () => "Synthetic SDK smoke assistant.",
    extensionFactories: [host.createCodemodeExtension({ mode: "only" }), piProcesses],
  });
  await loader.reload();
  const created = await host.createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model: modelRuntime.getModel("openai-codex", "gpt-6-astra"),
    settingsManager, sessionManager: host.SessionManager.inMemory(dir), resourceLoader: loader,
  });
  session = created.session;
  assert.deepEqual(created.extensionsResult.errors, []);
  await session.bindExtensions({ mode: "print", onError: e => errors.push(e) });
  await session.prompt("Start background validation; do independent work before consuming the result.");
  await session.waitForIdle();
  const completions = session.messages.filter(m => m.customType === "pi-processes-completed");
  assert.equal(completions.length, 1, JSON.stringify(session.messages
    .filter(m => m.role === "toolResult" || m.errorMessage)
    .map(m => ({ role: m.role, error: m.errorMessage, content: m.content }))));
  assert.equal(completions[0].display, false);
  assert.equal(completions[0].details.processes[0].exit_code, 0);
  assert.ok(completions[0].details.processes[0].output.includes("100"));
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1].input).includes("Background process completed."));
  assert.deepEqual(errors, []);
  console.log("PASS: installed-host codemode, concurrent commands, safe-boundary delivery, hidden completion and structured output.");
} finally {
  if (session) { await session.abort(); session.dispose(); }
  globalThis.fetch = fetch;
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
}
