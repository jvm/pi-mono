import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, cp, mkdir, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, before, after } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostDist = process.env.PI_COMPACTION_HOST_ENTRY ? dirname(resolve(process.env.PI_COMPACTION_HOST_ENTRY))
  : dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const hostManifest = JSON.parse(await readFile(join(hostDist, "..", "package.json"), "utf8"));
const hostCli = resolve(hostDist, "..", hostManifest.bin.pi);
// The npm CLI uses embedded virtual modules, unlike the ordinary SDK entry's
// filesystem aliases. Only the bundled host reproduces the reported 0.2.2 bug.
const {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} = await import(join(dirname(hostCli), "index.js"));
const kind = "pi-codex-compaction:automatic:v1";
let temp;
let entry;
process.env.CI = "1";
process.env.PI_OFFLINE = "1";

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "compaction-packed-"));
  entry = join(temp, "package", "index.ts");
  // Test what npm actually publishes, outside every workspace module root.
  const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
    cwd: root, maxBuffer: 1024 * 1024,
  });
  const [packed] = JSON.parse(stdout);
  await run("tar", ["-xzf", join(temp, packed.filename), "-C", temp]);
  assert.ok(packed.files.some((file) => file.path === "src/automatic-compaction.ts"));
  assert.ok(packed.files.some((file) => file.path === "src/inline-tools.ts"));
  assert.equal(packed.files.some((file) => /^(tests|node_modules)\//.test(file.path)), false);

  const manifest = JSON.parse(await readFile(join(temp, "package", "package.json"), "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.dependencies[name], undefined);
  }
  // Pi deliberately does NOT install host peers. Copy only declared runtime
  // dependencies; a peer symlink here hid the 0.2.2 production regression.
  for (const name of Object.keys(manifest.dependencies)) {
    let target = dirname(fileURLToPath(import.meta.resolve(name)));
    while (true) {
      const candidate = await readFile(join(target, "package.json"), "utf8").catch(() => "{}");
      if (JSON.parse(candidate).name === name) break;
      const parent = dirname(target);
      assert.notEqual(parent, target, `Cannot locate ${name}`);
      target = parent;
    }
    const destination = join(temp, "package", "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(target, destination, { recursive: true });
  }
  const require = createRequire(entry);
  for (const name of Object.keys(manifest.peerDependencies)) {
    assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" }, `${name} must be host-only`);
  }
});
after(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

function resourceLoader(settingsManager, extensionFactories = []) {
  return new DefaultResourceLoader({
    cwd: temp, agentDir: join(temp, "agent"), settingsManager,
    noExtensions: true, additionalExtensionPaths: [entry], extensionFactories,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "You are a test assistant.",
  });
}

test("loads the packed entry through Pi without physically installed host peers", async () => {
  const loader = resourceLoader(SettingsManager.inMemory({}));
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.ok(result.extensions[0].commands.has("server-compaction"));
  assert.ok(result.extensions[0].flags.has("server-compaction"));
  assert.equal(result.extensions[0].flags.has("server-compaction-tools"), false);
});

test("Pi CLI loads the packed extension and shows its flags outside the repository", async () => {
  const { stdout, stderr } = await run(process.execPath, [
    hostCli, "-ne", "-e", entry, "--offline", "--help",
  ], {
    cwd: temp, timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", PI_CODING_AGENT_DIR: join(temp, "cli-agent") },
  });
  assert.doesNotMatch(stderr, /Failed to load extension|Cannot find module|extension warning/i);
  assert.match(stdout, /--server-compaction/);
  assert.match(stdout, /--server-compaction-threshold/);
});

const checkpoint = { id: "cmp_packed", type: "compaction", encrypted_content: "synthetic-checkpoint" };
const call = { type: "function_call", id: "fc_packed", call_id: "call_packed", name: "packed_fixture",
  arguments: "{}", status: "completed" };
const text = (id) => ({ type: "message", id, role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "synthetic answer", annotations: [] }] });
function response(output, id) {
  const events = [
    { type: "response.created", response: { id, status: "in_progress" } },
    ...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response: { id, status: "completed", output: [],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

for (const mode of ["print", "json", "rpc"]) {
  test(`packed extension adopts, continues tools and reloads in ${mode} mode with host-only peers`, async (t) => {
    const requests = [];
    const outputs = [[checkpoint, call], [text("msg_tool_done")], [text("msg_reloaded")]];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      requests.push(JSON.parse(init.body));
      assert.ok(outputs.length, "No extra inference or serialization request is allowed");
      return response(outputs.shift(), `resp_${requests.length}`);
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-fixture-not-a-real-key" }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
      modelsStorePath: join(temp, `models-${mode}.json`), refreshOnCreate: false });
    const catalogModel = runtime.getModel("openai", "gpt-6-astra");
    // Bundled static catalogs can advertise effort transitions that the public
    // compaction route rejects. This contract exercises the compatible route;
    // separate request-policy tests prove configuration_update is left alone.
    const model = { ...catalogModel, compat: { ...catalogModel.compat, supportsMidConvoEffort: false } };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false },
      defaultTools: ["packed_fixture"],
    });
    const manager = SessionManager.inMemory(temp);
    const loader = resourceLoader(settingsManager, [(pi) => pi.registerTool({
      name: "packed_fixture", label: "Packed fixture", description: "Synthetic tool",
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "tool result" }], details: undefined }; },
    })]);
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: temp, agentDir: join(temp, "agent"),
      model, modelRuntime: runtime, settingsManager, sessionManager: manager, resourceLoader: loader, thinkingLevel: "low" });
    const errors = [];
    try {
      await session.bindExtensions({ mode, onError: (error) => errors.push(error) });
      await session.prompt("/server-compaction on 1000");
      await session.prompt("synthetic old context");
      assert.deepEqual(errors.map(error => ({ event: error.event, error: error.error })), []);
      assert.equal(requests.length, 2, "ordinary inference plus tool continuation only");
      assert.deepEqual(requests[0].context_management, [{ type: "compaction", compact_threshold: 1000 }],
        JSON.stringify({ route: [model.provider, model.api, model.baseUrl], input: requests[0].input.map(i => ({
          type: i.type, role: i.role, tools: i.tools?.map(t => [t.type, t.name]),
        })), tools: requests[0].tools?.map(t => [t.type, t.name]) }));
      assert.equal(manager.getBranch().some((item) => item.type === "compaction" && item.details?.kind === kind), true);
      assert.deepEqual(requests[1].input.find((item) => item.type === "compaction"), checkpoint);
      assert.deepEqual(requests[1].input.find((item) => item.type === "function_call"), call);
      assert.equal(requests[1].input.find((item) => item.type === "function_call_output").output, "tool result");
      await session.prompt("/server-compaction off");
      await session.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      await session.prompt("synthetic next context");
      assert.equal(requests.length, 3);
      assert.equal(requests[2].context_management, undefined);
      assert.deepEqual(requests[2].input.find((item) => item.type === "compaction"), checkpoint);
      assert.doesNotMatch(JSON.stringify(requests[2].input), /synthetic old context/);
      assert.equal(session.getSessionStats().tokens.total, 75, "serialization must not add usage");
      assert.deepEqual(errors, []);
    } finally { session.dispose(); }
  });
}
