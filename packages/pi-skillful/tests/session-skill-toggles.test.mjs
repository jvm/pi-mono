import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

const home = await mkdtemp(join(tmpdir(), "pi-skillful-toggles-test-"));
process.env.HOME = home;

const {
  default: sessionSkillToggles,
  refreshSessionSkillToggles,
} = await import("../.test-dist/src/extensions/session-skill-toggles.js");

const globalSettingsPath = join(home, ".pi", "agent", "settings.json");
const editorTheme = { borderColor: (text) => text, selectList: {} };
const theme = { fg: (_color, text) => text };
const keybindings = { matches: () => false };

function skillCommand(name, scope = "user") {
  const path = join(home, `${name}.md`);
  return {
    name: `skill:${name}`,
    description: `${name} description`,
    source: "skill",
    sourceInfo: { path, source: "auto", scope, origin: "top-level", baseDir: home },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeGlobal(skillful) {
  await writeJson(globalSettingsPath, { skillful });
}

function createEditor({ focusable = false, customHooks = false } = {}) {
  const delegated = [];
  const shortcutInputs = [];
  let text = "";
  const editor = {
    delegated,
    shortcutInputs,
    handleInput(data) {
      if (this.onExtensionShortcut?.(data)) {
        shortcutInputs.push(data);
        return;
      }
      delegated.push(data);
    },
    invalidate: () => undefined,
    getText: () => text,
    render(width) {
      return ["─".repeat(width), `${this.focused ? CURSOR_MARKER : ""}cursor`];
    },
    setText(value) {
      text = value;
    },
  };
  if (focusable) editor.focused = false;
  if (customHooks) editor.actionHandlers = new Map();
  return editor;
}

function createHarness({ commands = [], previousEditor } = {}) {
  const handlers = new Map();
  const notifications = [];
  const setEditorCalls = [];
  let shortcutRegistrations = 0;
  let currentFactory = previousEditor ? () => previousEditor : undefined;
  const tui = { renders: 0, requestRender() { this.renders++; } };
  const ui = {
    getEditorComponent: () => currentFactory,
    notify: (message, type) => notifications.push({ message, type }),
    setEditorComponent: (factory) => {
      currentFactory = factory;
      setEditorCalls.push(factory);
    },
    theme,
  };
  const pi = {
    getCommands: () => commands,
    on: (event, handler) => handlers.set(event, handler),
    registerShortcut: () => shortcutRegistrations++,
  };
  sessionSkillToggles(pi);

  return {
    handlers,
    notifications,
    pi,
    setEditorCalls,
    shortcutRegistrations: () => shortcutRegistrations,
    tui,
    ui,
    createInstalledEditor() {
      assert.ok(currentFactory, "expected installed editor factory");
      return currentFactory(tui, editorTheme, keybindings);
    },
  };
}

async function start(harness, cwd, projectTrusted) {
  const ctx = {
    cwd,
    isProjectTrusted: () => projectTrusted,
    mode: "tui",
    ui: harness.ui,
  };
  await harness.handlers.get("session_start")({ reason: "startup" }, ctx);
  return ctx;
}

async function shutdown(harness, ctx) {
  await harness.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
}

test("empty settings register and reserve no shortcuts", async () => {
  const cwd = await mkdtemp(join(home, "empty-"));
  await writeGlobal({});
  const previousEditor = createEditor();
  const harness = createHarness({ commands: [skillCommand("one")], previousEditor });
  const ctx = await start(harness, cwd, false);

  assert.equal(harness.shortcutRegistrations(), 0);
  assert.equal(harness.setEditorCalls.length, 0);

  await shutdown(harness, ctx);
});

test("only assigned modifier-slot keys are consumed and collisions receive non-matches", async () => {
  const cwd = await mkdtemp(join(home, "assigned-"));
  await writeGlobal({ toggleSlots: { 1: "one" }, toggleModifier: "alt" });
  const inner = createEditor({ customHooks: true });
  inner.onExtensionShortcut = (data) => data === "\x1b2";
  const harness = createHarness({ commands: [skillCommand("one")], previousEditor: inner });
  const ctx = await start(harness, cwd, false);
  const editor = harness.createInstalledEditor();

  editor.handleInput("\x1b2");
  editor.handleInput("\x1b[49;5u");
  editor.handleInput("\x1b1");
  const notificationCount = harness.notifications.length;
  editor.handleInput("\x1b[49;3:2u");
  editor.handleInput("\x1b[49;3:3u");

  assert.deepEqual(inner.shortcutInputs, ["\x1b2"]);
  assert.deepEqual(inner.delegated, ["\x1b[49;5u"]);
  assert.equal(harness.notifications.length, notificationCount);
  assert.match(harness.notifications.at(-1).message, /one inactive for this session/);

  await shutdown(harness, ctx);
});

test("modifier changes take effect without reserving old keys", async () => {
  const cwd = await mkdtemp(join(home, "modifier-"));
  await writeGlobal({ toggleSlots: { 1: "one" }, toggleModifier: "alt" });
  const inner = createEditor();
  const harness = createHarness({ commands: [skillCommand("one")], previousEditor: inner });
  const ctx = await start(harness, cwd, false);
  const editor = harness.createInstalledEditor();

  await writeGlobal({ toggleSlots: { 1: "one" }, toggleModifier: "ctrl" });
  await refreshSessionSkillToggles(harness.pi, cwd, false, harness.ui);
  editor.handleInput("\x1b1");
  editor.handleInput("\x1b[49;5u");

  assert.deepEqual(inner.delegated, ["\x1b1"]);
  assert.match(harness.notifications.at(-1).message, /one inactive for this session/);

  await shutdown(harness, ctx);
});

test("wrapper propagates focus and custom-editor hooks", async () => {
  const cwd = await mkdtemp(join(home, "focusable-"));
  await writeGlobal({ toggleSlots: { 1: "one" } });
  const inner = createEditor({ focusable: true, customHooks: true });
  const harness = createHarness({ commands: [skillCommand("one")], previousEditor: inner });
  const ctx = await start(harness, cwd, false);
  const editor = harness.createInstalledEditor();

  editor.focused = true;
  assert.equal(inner.focused, true);
  assert.ok(editor.render(40).join("\n").includes(CURSOR_MARKER));

  const escape = () => undefined;
  const borderColor = (text) => `new:${text}`;
  inner.borderColor = (text) => `old:${text}`;
  editor.onEscape = escape;
  editor.actionHandlers.set("app.clear", escape);
  editor.borderColor = borderColor;
  assert.equal(inner.onEscape, escape);
  assert.equal(inner.actionHandlers.get("app.clear"), escape);
  assert.equal(inner.borderColor, borderColor);

  editor.focused = false;
  assert.equal(inner.focused, false);

  await shutdown(harness, ctx);
});

test("wrapper safely supports non-focusable editors", async () => {
  const cwd = await mkdtemp(join(home, "non-focusable-"));
  await writeGlobal({ toggleSlots: { 1: "one" } });
  const inner = createEditor();
  const harness = createHarness({ commands: [skillCommand("one")], previousEditor: inner });
  const ctx = await start(harness, cwd, false);
  const editor = harness.createInstalledEditor();

  assert.doesNotThrow(() => {
    editor.focused = true;
  });
  assert.equal(editor.focused, true);
  assert.equal(Object.hasOwn(inner, "focused"), false);

  await shutdown(harness, ctx);
});

test("project toggle settings apply only when project is trusted", async () => {
  const cwd = await mkdtemp(join(home, "trust-"));
  await writeGlobal({ toggleSlots: { 1: "global-skill" }, toggleModifier: "ctrl" });
  await writeJson(join(cwd, ".pi", "settings.json"), {
    skillful: { toggleSlots: { 2: "project-skill" }, toggleModifier: "alt" },
  });
  const commands = [skillCommand("global-skill"), skillCommand("project-skill", "project")];

  const untrustedInner = createEditor();
  const untrusted = createHarness({ commands, previousEditor: untrustedInner });
  const untrustedCtx = await start(untrusted, cwd, false);
  const untrustedEditor = untrusted.createInstalledEditor();
  untrustedEditor.handleInput("\x1b[49;5u");
  untrustedEditor.handleInput("\x1b2");
  assert.match(untrusted.notifications.at(-1).message, /global-skill inactive/);
  assert.deepEqual(untrustedInner.delegated, ["\x1b2"]);
  await shutdown(untrusted, untrustedCtx);

  const trustedInner = createEditor();
  const trusted = createHarness({ commands, previousEditor: trustedInner });
  const trustedCtx = await start(trusted, cwd, true);
  const trustedEditor = trusted.createInstalledEditor();
  trustedEditor.handleInput("\x1b2");
  trustedEditor.handleInput("\x1b[49;5u");
  assert.match(trusted.notifications.at(-1).message, /project-skill inactive/);
  assert.deepEqual(trustedInner.delegated, ["\x1b[49;5u"]);
  await shutdown(trusted, trustedCtx);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
