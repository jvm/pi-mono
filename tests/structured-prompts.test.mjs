import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createCodemodeExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { codexHarness, requestBody, textResponse } from "./codex-harness.mjs";

// File-isolated environment, real extension factories, and no live credentials or requests.
const profile = await mkdtemp(join(tmpdir(), "pi-structured-prompts-"));
const env = { HOME: profile, PI_CODING_AGENT_DIR: join(profile, ".pi", "agent"), CI: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const { default: skillful } = await import("../packages/pi-skillful/extensions/index.ts");
const { default: scout } = await import("../packages/pi-scout/extensions/index.ts");
const { saveState, loadState } = await import("../packages/pi-scout/src/state.ts");
const globalSettings = join(profile, ".pi", "agent", "settings.json");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

function systems(h) {
  return h.sessionManager.buildSessionContext().messages.filter(message => message.role === "system");
}

function promptState(h) {
  return getCurrentSystemPrompt(h.sessionManager.buildSessionContext().messages);
}

function requestSystems(body) {
  return body.input.filter(message => message.role === "system" || message.role === "developer");
}

function requestText(body) {
  return [body.instructions ?? "", ...requestSystems(body).map(message => typeof message.content === "string"
    ? message.content : message.content.map(block => block.text ?? "").join("\n"))].filter(Boolean).join("\n");
}

function assertVisible(text, names, hidden = []) {
  for (const name of names) assert.ok(text.includes(`<name>${name}</name>`), `${name} should be advertised`);
  for (const name of hidden) assert.ok(!text.includes(`<name>${name}</name>`), `${name} should not be advertised`);
}

/** Exercise the real provider serializer with an API that folds system updates into its head. */
function collapsingProvider(pi) {
  pi.registerProvider("fixture-collapse", {
    api: "anthropic-messages", baseUrl: "https://fixture.invalid", apiKey: "fixture-only-not-a-secret",
    models: [{
      id: "fixture-model", name: "Fixture model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1024,
      compat: { supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false },
    }],
  });
}

function anthropicResponse() {
  const events = [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant",
      model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(profile, "workspace-"));
  const clone = join(cwd, "reference");
  await mkdir(clone);
  const repo = {
    id: "private-record-id", name: "reference-one", path: clone,
    source: "https://fixture-user:fixture-private@fixture.invalid/reference.git", branch: "private-branch",
    createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z",
  };
  await saveState({ repos: [repo] });
  const settings = options.settings ?? { hiddenSkills: ["hidden", "package-skill"] };
  await writeJson(globalSettings, { skillful: settings });
  const skills = [];
  for (const name of ["visible", "hidden", "package-skill", "upstream-hidden", "frontmatter-hidden"]) {
    const filePath = join(cwd, "skills", name, "SKILL.md");
    const disableModelInvocation = name === "frontmatter-hidden";
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `---\nname: ${name}\ndescription: ${name} fixture\n${disableModelInvocation ? "disable-model-invocation: true\n" : ""}---\nInstructions for ${name}.\n`);
    skills.push({
      name, description: `${name} fixture`, filePath, baseDir: dirname(filePath), source: "fixture",
      disableModelInvocation,
      sourceInfo: { path: filePath, source: "fixture", scope: "user",
        origin: name === "package-skill" ? "package" : "top-level", baseDir: dirname(filePath) },
    });
  }
  let editorFactory = () => ({ handleInput() {}, render: () => [""], getText: () => "", setText() {}, invalidate() {} });
  const ui = {
    theme: { fg: (_color, text) => text }, notify() {},
    getEditorComponent: () => editorFactory,
    setEditorComponent: factory => { editorFactory = factory; },
  };
  const marker = { text: "Unrelated extension context." };
  const other = pi => pi.on("before_agent_start", event => {
    event.systemPromptOptions.sections.fixture_context = marker.text;
    event.systemPromptOptions.skills = event.systemPromptOptions.skills.map(skill =>
      skill.name === "upstream-hidden" ? { ...skill, disableModelInvocation: true } : skill);
  });
  const packages = options.reverse ? [scout, skillful] : [skillful, scout];
  const factories = [
    ...(options.codemode ? [createCodemodeExtension({ mode: "only" })] : []),
    ...(options.before ?? []),
    ...(!options.otherLast ? [other] : []),
    ...packages,
    ...(options.otherLast ? [other] : []),
    ...(options.after ?? []),
  ];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = requestBody(init);
    requests.push(body);
    if (Array.isArray(body.input)) return textResponse();
    if (Array.isArray(body.messages)) return anthropicResponse();
    throw new Error("Unexpected fixture request; network is disabled");
  };
  const handles = [];
  const closed = new Set();
  const close = async h => {
    if (closed.has(h)) return;
    closed.add(h);
    try {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally { await h.close(); }
    assert.deepEqual(h.errors, []);
  };
  t.after(async () => {
    try {
      for (const h of handles) await close(h);
    } finally { globalThis.fetch = originalFetch; }
  });
  const open = async (sessionManager, reason = "startup") => {
    if (handles.length) await close(handles.at(-1));
    const h = await codexHarness(factories, {
      cwd, skills, sessionManager, sessionStartEvent: { type: "session_start", reason },
      defaultTools: options.codemode ? ["read", "codemode"] : ["read"],
      ...(options.tui ? { bindings: { mode: "tui", uiContext: ui } } : {}),
    });
    handles.push(h);
    return h;
  };
  const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
  const h = await open(sessionManager);
  return {
    ...h, cwd, clone, repo, skills, settings, marker, requests, open,
    editor: () => editorFactory({ requestRender() {} }, {}, {}),
    writeSettings: value => writeJson(globalSettings, { skillful: value }),
    async prompt(text = "Fixture request.", target = h) {
      const count = requests.length;
      await target.session.prompt(text);
      assert.equal(requests.length, count + 1);
      assert.equal(target.session.messages.at(-1).stopReason, "stop");
      return requests.at(-1);
    },
  };
}

for (const reverse of [false, true]) {
  for (const codemode of [false, true]) {
    test(`structured skill/Scout updates compose: reverse=${reverse}, codemode=${codemode}`, async t => {
      const h = await fixture(t, { reverse, codemode });
      const first = await h.prompt();
      const initial = structuredClone(systems(h)[0]);
      assertVisible(requestText(first), ["visible", "package-skill"], ["hidden", "upstream-hidden", "frontmatter-hidden"]);
      assertVisible(initial.sections.skills, ["visible", "package-skill"], ["hidden", "upstream-hidden", "frontmatter-hidden"]);
      assert.ok(initial.sections.scout_repos.includes(h.clone));
      assert.ok(initial.sections.fixture_context.includes(h.marker.text));
      assert.doesNotMatch(JSON.stringify(first), /fixture-private|private-branch|private-record-id/);
      assert.equal(h.skills.find(skill => skill.name === "hidden").disableModelInvocation, false);
      if (codemode) {
        assert.ok(!first.tools.some(tool => tool.name === "read"));
        assert.doesNotMatch(initial.sections.skills, /Use the read tool/);
      }

      await h.writeSettings({ hiddenSkills: ["visible"] });
      await saveState({ repos: [{ ...h.repo, name: "reference-two" }] });
      h.marker.text = "Updated unrelated context.";
      const second = await h.prompt();
      assert.deepEqual(systems(h)[0], initial, "the original prompt is not rewritten");
      const patch = systems(h).at(-1);
      assert.deepEqual(Object.keys(patch.sections).sort(), ["fixture_context", "scout_repos", "skills"]);
      assertVisible(patch.sections.skills, ["hidden", "package-skill"], ["visible", "upstream-hidden", "frontmatter-hidden"]);
      assert.match(patch.sections.scout_repos, /reference-two/);
      assert.equal(second.instructions, first.instructions, "native system updates preserve the leading prompt");
      assert.ok(requestSystems(second).length > 0, "the provider receives the section update in the conversation");
      assert.match(requestText(second), /reference-two/);
      const count = systems(h).length;
      await h.prompt();
      assert.equal(systems(h).length, count, "unchanged state does not append another system update");

      await rm(h.clone, { recursive: true }); // Only this test's disposable reference directory.
      const removed = await h.prompt();
      assert.deepEqual((await loadState()).repos, []);
      assert.equal(systems(h).at(-1).sections.scout_repos, null);
      assert.ok(!promptState(h).includes("Scout repos:"));
      assert.ok(!removed.tools.some(tool => tool.name === "scout_rm"));
    });
  }
}

for (const otherLast of [false, true]) {
  test(`toggles respect visibility restrictions and package skills: otherLast=${otherLast}`, async t => {
    const h = await fixture(t, { otherLast, tui: true, settings: {
      hiddenSkills: ["hidden", "package-skill"], toggleSlots: { 1: "hidden", 2: "package-skill", 3: "upstream-hidden", 4: "frontmatter-hidden" },
    } });
    await h.prompt();
    assertVisible(promptState(h), ["visible", "package-skill"], ["hidden", "upstream-hidden", "frontmatter-hidden"]);
    const editor = h.editor();
    editor.handleInput("\x1b1");
    editor.handleInput("\x1b2"); // Package skill has no assigned slot.
    await h.prompt();
    assertVisible(promptState(h), ["visible", "hidden", "package-skill"], ["upstream-hidden", "frontmatter-hidden"]);
    assert.deepEqual(Object.keys(systems(h).at(-1).sections), ["skills"]);
    assert.match(promptState(h), /Scout repos:/);
    editor.handleInput("\x1b1");
    await h.prompt();
    assertVisible(promptState(h), ["package-skill"], ["hidden"]);
    editor.handleInput("\x1b1");
    await h.prompt();
    assertVisible(promptState(h), ["hidden"]);
    await h.session.reload();
    await h.prompt();
    assertVisible(promptState(h), ["visible", "package-skill"], ["hidden", "upstream-hidden", "frontmatter-hidden"]);
  });
}

test("hidden skills remain available through explicit and inline invocation", async t => {
  const h = await fixture(t);
  for (const input of ["/skill:hidden explain this", "Please use /skill:hidden for this task."]) {
    const request = await h.prompt(input);
    assertVisible(promptState(h), ["visible"], ["hidden"]);
    const userText = JSON.stringify(request.input.filter(message => message.role === "user"));
    assert.ok(userText.includes("Instructions for hidden."));
    assert.ok(!userText.includes("---\\nname:"));
  }
});

for (const placement of ["before", "after"]) {
  for (const form of ["return", "force"]) {
    test(`explicit full-prompt ${form} override wins ${placement} both packages`, async t => {
      const override = pi => pi.on("before_agent_start", event => {
        if (form === "return") return { systemPrompt: "Exact fixture policy." };
        event.systemPromptOptions.forceSystemPrompt = "Exact fixture policy.";
      });
      const h = await fixture(t, { [placement]: [override] });
      for (let turn = 0; turn < 2; turn++) {
        const request = await h.prompt();
        assert.equal(requestText(request), "Exact fixture policy.");
        assert.equal(requestSystems(request).length, 0);
      }
    });
  }
}

test("a provider without mid-conversation system updates receives the current checkpoint", async t => {
  const h = await fixture(t, { before: [collapsingProvider] });
  await h.session.setModel(h.modelRuntime.getModel("fixture-collapse", "fixture-model"));
  const first = await h.prompt();
  assertVisible(JSON.stringify(first.system), ["visible", "package-skill"], ["hidden"]);
  await h.writeSettings({ hiddenSkills: ["visible"] });
  await saveState({ repos: [] });
  const second = await h.prompt();
  assertVisible(JSON.stringify(second.system), ["hidden", "package-skill"], ["visible", "upstream-hidden"]);
  assert.doesNotMatch(JSON.stringify(second.system), /Scout repos:/);
  assert.ok(second.messages.every(message => message.role !== "system"));
  assert.equal(systems(h).at(-1).sections.scout_repos, null, "transcript retains section deltas");
});

test("reload, tree navigation, resume, and fork replay structured changes without stale Scout context", async t => {
  const h = await fixture(t);
  await h.prompt();
  const originalLeaf = h.sessionManager.getLeafId();
  await h.writeSettings({ hiddenSkills: ["visible"] });
  await saveState({ repos: [] });
  await h.prompt();
  const changedLeaf = h.sessionManager.getLeafId();
  const count = systems(h).length;
  await h.session.reload();
  await h.prompt();
  assert.equal(systems(h).length, count);
  assertVisible(promptState(h), ["hidden"], ["visible"]);
  assert.ok(!promptState(h).includes("Scout repos:"));
  await h.session.navigateTree(originalLeaf, { summarize: false });
  await h.prompt();
  assert.equal(systems(h).at(-1).sections.scout_repos, null);
  assertVisible(promptState(h), ["hidden"], ["visible"]);
  await h.session.navigateTree(changedLeaf, { summarize: false });
  await h.prompt();
  assertVisible(promptState(h), ["hidden"], ["visible"]);
  const file = h.sessionManager.getSessionFile();
  const fork = h.sessionManager.createBranchedSession(originalLeaf);
  for (const [path, reason] of [[file, "resume"], [fork, "fork"]]) {
    const restored = await h.open(SessionManager.open(path), reason);
    await h.prompt("Restored fixture.", restored);
    assertVisible(promptState(restored), ["hidden", "package-skill"], ["visible"]);
    assert.ok(!promptState(restored).includes("Scout repos:"));
    assert.ok(systems(restored).some(message => message.sections?.scout_repos === null));
  }
});

test.after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(profile, { recursive: true, force: true });
});
