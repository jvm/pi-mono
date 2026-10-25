import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFreeformInputSchema, createOpenAILarkSampling } from "../../pi-codex-tools/src/grammar.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";
const kind = "pi-codex-compaction:automatic:v1";
const source = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const checkpoint = { type: "compaction", id: "cmp_host", encrypted_content: "synthetic-only" };
const text = (id) => ({ type: "message", id, role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "synthetic answer", annotations: [] }] });
const call = (id, raw = false) => ({
  type: raw ? "custom_tool_call" : "function_call", id: `${raw ? "ctc" : "fc"}_${id}`, call_id: `call_${id}`,
  name: raw ? "host_raw" : "host_fixture", status: "completed",
  ...(raw ? { input: "PING" } : { arguments: '{"version":1}' }),
});

// Opt-in contract test against the installed SDK's PUBLIC entry point. Ordinary
// CI still exercises the inline shape in automatic.test.mjs with pinned peers.
// No provider serializer subpaths or physical Pi AI files are resolved.
test("installed-host inline-tool contracts", {
  skip: !process.env.PI_COMPACTION_HOST_ENTRY && "Set PI_COMPACTION_HOST_ENTRY to an installed SDK entry",
}, async (t) => {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
    createCodemodeExtension } = await import(pathToFileURL(process.env.PI_COMPACTION_HOST_ENTRY).href);
  const dir = await mkdtemp(join(tmpdir(), "pi-inline-host-test-"));
  const seedEntry = join(dir, "seed.ts");
  const sessions = [];
  const requests = [];
  let outputs = [];
  let executions = [];
  let nextInputTokens = 100;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses", "All transport is mocked");
    requests.push(JSON.parse(init.body));
    assert.ok(outputs.length, "Unexpected inference request");
    const output = outputs.shift();
    const inputTokens = nextInputTokens;
    nextInputTokens = 100;
    const id = `resp_${requests.length}`;
    const events = [{ type: "response.created", response: { id, status: "in_progress" } }];
    for (const [output_index, item] of output.entries()) {
      events.push({ type: "response.output_item.added", output_index,
        item: item.type === "message" ? { ...item, content: [] } : item });
      events.push({ type: "response.output_item.done", output_index, item });
    }
    events.push({ type: "response.completed", response: { id, status: "completed", output: [],
      usage: { input_tokens: inputTokens, output_tokens: 20, total_tokens: inputTokens + 20 } } });
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  });
  try {
    // Seed an authentic legacy checkpoint through the public payload boundary.
    // This is a TEST adapter only, not part of the production implementation.
    await writeFile(seedEntry, `
      import extension from ${JSON.stringify(source)};
      export default function(pi) {
        pi.on("before_provider_request", event => {
          const p = event.payload;
          return { ...p, tools: p.input.filter(i => i.type === "additional_tools").flatMap(i => i.tools),
            input: p.input.filter(i => i.type !== "additional_tools") };
        });
        extension(pi);
      }
    `);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({ type: "api_key", key: "offline-test-fixture" }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(dir, "models.json") });
    const model = runtime.getModel("openai", "gpt-6-astra");
    assert.ok(model);

    async function make({ manager = SessionManager.inMemory(dir), seed = false, codemode = false, settings = {} } = {}) {
      const errors = [];
      let api;
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
        defaultTools: ["host_fixture", "host_raw", ...(codemode ? ["codemode"] : [])],
        ...settings,
      });
      const factories = [
        ...(codemode ? [createCodemodeExtension({ mode: "only" })] : []),
        pi => {
          api = pi;
          pi.registerTool({
            name: "host_fixture", label: "Host fixture", description: "Version one",
            parameters: { type: "object", properties: { version: { type: "integer", const: 1 } }, required: ["version"] },
            async execute(_id, args) {
              executions.push(["host_fixture", args]);
              return { content: [{ type: "text", text: "fixture result" }], details: undefined, terminate: true };
            },
          });
          pi.registerTool({
            name: "host_raw", label: "Raw fixture", description: "Grammar fixture",
            parameters: createFreeformInputSchema("input", "Synthetic raw input"),
            constrainedSampling: createOpenAILarkSampling('start: "PING"'),
            async execute(_id, args) {
              executions.push(["host_raw", args]);
              return { content: [{ type: "text", text: "PONG" }], details: undefined, terminate: true };
            },
          });
        },
      ];
      const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
        additionalExtensionPaths: [seed ? seedEntry : entry], extensionFactories: factories,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPromptOverride: () => "Synthetic offline contract test.",
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const { session } = await createAgentSession({
        cwd: dir, agentDir: dir, model, modelRuntime: runtime, sessionManager: manager,
        settingsManager, resourceLoader: loader, thinkingLevel: "low",
      });
      sessions.push(session);
      await session.bindExtensions({ mode: "print", onError: e => errors.push(e) });
      await session.prompt("/server-compaction on 1000");
      return { session, manager, errors, get api() { return api; } };
    }
    async function seed(items = [checkpoint, text("msg_seed")]) {
      const h = await make({ seed: true });
      outputs.push(items);
      await h.session.prompt("synthetic old history");
      assert.ok(requests.at(-1).context_management);
      assert.equal(h.manager.getBranch().filter(e => e.type === "compaction").length, 1);
      assert.deepEqual(h.errors, []);
      h.session.dispose();
      return h.manager;
    }
    async function prompt(h, output = [text(`msg_${requests.length}`)]) {
      outputs.push(output);
      await h.session.prompt("use the current harmless fixture");
      assert.deepEqual(h.errors, []);
      assert.equal(outputs.length, 0);
      return requests.at(-1);
    }
    function checkReplay(p, { initialTools = true, automatic = true } = {}) {
      assert.equal(!!p.context_management, automatic);
      const index = p.input.findIndex(i => i.type === "compaction");
      assert.ok(index >= 0);
      assert.deepEqual(p.input[index], checkpoint);
      if (!automatic) {
        if (initialTools) assert.equal(p.input[index + 1].type, "additional_tools");
        assert.equal(p.input.slice(0, index).some(i => i.type === "additional_tools"), false);
      } else {
        assert.equal(p.tools[0].type, "namespace");
      }
      return p.input.slice(index + 1);
    }
    await t.test("fresh native declarations enable compaction for function and grammar execution", async () => {
      const h = await make();
      executions = [];
      const p = await prompt(h, [checkpoint, call("fresh"), call("fresh_raw", true)]);
      assert.ok(p.context_management);
      assert.equal(p.tools[0].type, "namespace", "Native inline initial state is promoted to the namespace base");
      assert.equal(p.input.some(i => i.type === "additional_tools"), false, "Never declare the initial base twice");
      assert.deepEqual(executions.map(e => e[0]).sort(), ["host_fixture", "host_raw"]);
      assert.equal(h.manager.getBranch().some(e => e.type === "compaction"), true);
      h.session.dispose();
    });
    for (const raw of [false, true]) {
      for (const position of ["before", "after"]) {
        await t.test(`${raw ? "grammar" : "function"} call ${position} checkpoint keeps later results`, async () => {
          const c = call(`${raw}_${position}`, raw);
          const manager = await seed(position === "before" ? [c, checkpoint] : [checkpoint, c]);
          const h = await make({ manager });
          const p = await prompt(h);
          const suffix = checkReplay(p);
          assert.equal(suffix.filter(i => i.type === c.type).length, position === "before" ? 0 : 1);
          const output = suffix.find(i => i.type === (raw ? "custom_tool_call_output" : "function_call_output"));
          assert.equal(output.call_id, c.call_id);
          assert.match(JSON.stringify(output.output), raw ? /PONG/ : /fixture result/);
          assert.equal(p.tools[0].tools.find(tool => tool.name === "host_raw").format.definition, 'start: "PING"');
          h.session.dispose();
        });
      }
    }
    await t.test("namespaced function and grammar calls retain exact replay identity", async () => {
      const calls = [call("namespaced"), call("namespaced_raw", true)]
        .map(c => ({ ...c, namespace: "synthetic_fixtures" }));
      const h = await make({ manager: await seed([checkpoint, ...calls]) });
      const suffix = checkReplay(await prompt(h));
      assert.deepEqual(suffix.filter(i => i.type === "function_call" || i.type === "custom_tool_call"), calls);
      assert.deepEqual(suffix.filter(i => i.type?.endsWith("_output")).map(i => i.call_id).sort(),
        calls.map(i => i.call_id).sort());
      h.session.dispose();
    });
    await t.test("removed and redefined tools survive mode-off, reload and branches", async () => {
      const h = await make({ manager: await seed() });
      h.api.setActiveTools(["host_raw"]);
      let suffix = checkReplay(await prompt(h));
      assert.ok(suffix.some(i => i.role === "developer" && /no longer available/.test(i.content)),
        "Later removal notice must remain after checkpoint replay");
      h.api.registerTool({
        name: "host_raw", label: "Changed fixture", description: "Replacement grammar",
        parameters: createFreeformInputSchema("input", "Replacement input"),
        constrainedSampling: createOpenAILarkSampling('start: "PONG"'),
        async execute() { return { content: [], details: undefined, terminate: true }; },
      });
      suffix = checkReplay(await prompt(h));
      const latest = suffix.flatMap(i => i.type === "additional_tools" ? i.tools : [])
        .filter(tool => tool.name === "host_raw").at(-1);
      assert.equal(latest.format.definition, 'start: "PONG"');
      await h.session.prompt("/server-compaction off");
      await h.session.reload();
      checkReplay(await prompt(h), { automatic: false });
      const compact = h.manager.getBranch().find(e => e.type === "compaction");
      const user = h.manager.getBranch().find(e => e.type === "message" && e.message.role === "user");
      await h.session.navigateTree(user.id, { summarize: false });
      const abandoned = await prompt(h);
      assert.equal(abandoned.input.some(i => i.type === "compaction"), false);
      assert.ok(abandoned.context_management, "Branch restores its earlier enabled configuration");
      await h.session.navigateTree(compact.id, { summarize: false });
      checkReplay(await prompt(h));
      h.session.dispose();
    });
    for (const saved of [false, true]) {
      await t.test(`codemode-hidden declarations stay hidden (${saved ? "saved checkpoint" : "fresh session"})`, async () => {
        const h = await make({ codemode: true, ...(saved ? { manager: await seed() } : {}) });
        // Resume restores the saved active set, not a newly supplied default.
        h.api.setActiveTools([...h.api.getActiveTools(), "codemode"]);
        const p = await prompt(h);
        assert.ok(p.context_management);
        // The old tools can all be hidden, leaving no declaration before the
        // retained assistant. A later loadout delta then introduces codemode.
        if (saved) checkReplay(p, { initialTools: false });
        const tools = p.input.filter(i => i.type === "additional_tools").flatMap(i => i.tools);
        assert.ok(p.tools[0].tools.some(tool => tool.name === "codemode"));
        assert.equal(tools.some(tool => tool.name === "host_fixture" || tool.name === "host_raw"), false);
        assert.deepEqual(p.tools[0].tools.map(t => t.name), ["codemode"]);
        h.session.dispose();
      });
    }
    await t.test("multiple compaction epochs preserve cache prefixes, current schemas and native delta positions", async () => {
      const h = await make();
      const names = p => p.tools.flatMap(group => group.tools.map(tool => tool.name));
      const declareLate = version => h.api.registerTool({
        name: "late_fixture", label: "Late fixture", description: `Version ${version}`,
        parameters: { type: "object", properties: { version: { type: "integer", const: version } }, required: ["version"] },
        async execute(_id, args) {
          executions.push(["late_fixture", args]);
          return { content: [{ type: "text", text: "late result" }], details: undefined, terminate: true };
        },
      });
      const lateCall = (id, version) => ({ ...call(id), name: "late_fixture", arguments: JSON.stringify({ version }) });
      const original = await prompt(h);
      declareLate(1);
      const added = await prompt(h, [lateCall("late", 1)]);
      assert.deepEqual(added.tools, original.tools, "Adding a tool must not invalidate the top-level prefix");
      assert.deepEqual(added.input.slice(0, original.input.length), original.input);
      assert.equal(added.input.at(-2).type, "additional_tools", "New declarations remain at their native position");
      assert.equal(names(added).includes("late_fixture"), false, "Do not eagerly promote additions");
      declareLate(2);
      const changed = await prompt(h, [checkpoint, lateCall("late_changed", 2)]);
      assert.deepEqual(changed.tools, original.tools, "An inline-only schema update retains the base");
      assert.equal(changed.input.filter(i => i.type === "additional_tools").at(-1).tools[0].parameters.properties.version.const, 2);
      const replayed = await prompt(h, [checkpoint, text("msg_second_epoch")]);
      assert.ok(names(replayed).includes("late_fixture"), "Checkpoint starts a new base with all visible tools");
      assert.equal(replayed.tools[0].tools.find(t => t.name === "late_fixture").parameters.properties.version.const, 2);
      const again = await prompt(h, [checkpoint, text("msg_third_epoch")]);
      assert.deepEqual(again.tools, replayed.tools, "Repeated compaction must not change an unchanged tool base");
      assert.equal(again.input.filter(i => i.type === "compaction").length, 1);
      assert.equal(JSON.stringify(again.input).includes("use the current harmless fixture"), true, "New user input survives");
      await h.session.reload();
      declareLate(2);
      const reloaded = await prompt(h);
      assert.deepEqual(reloaded.tools, replayed.tools, "Reload reconstructs the same epoch without extension-local state");
      assert.deepEqual(h.errors, []);
      h.session.dispose();
    });
    await t.test("standard threshold compaction still runs when automatic inference returns no checkpoint", async () => {
      const h = await make({ settings: {
        compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 1 },
      } });
      await prompt(h);
      h.manager.appendMessage({ role: "user", content: "old context ".repeat(3000), timestamp: 1 });
      h.manager.appendMessage({ role: "user", content: "recent fixture", timestamp: 2 });
      nextInputTokens = model.contextWindow - 4096;
      const before = requests.length;
      outputs.push([text("msg_high_usage")], [text("msg_summary")], [text("msg_prefix_summary")]);
      await h.session.prompt("continue the synthetic fixture");
      assert.equal(outputs.length, 0);
      assert.equal(requests.length - before, 3, "Ordinary request plus two standard split-span summaries");
      assert.ok(requests[before].context_management);
      assert.ok(requests.slice(before + 1).every(p => p.context_management === undefined));
      assert.ok(h.manager.getBranch().some(e => e.type === "compaction" && e.details?.kind !== kind));
      assert.deepEqual(h.errors, []);
      h.session.dispose();
    });
  } finally {
    for (const session of sessions) session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
