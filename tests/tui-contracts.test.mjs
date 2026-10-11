import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { FooterComponent, initTheme, SessionManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, TuiAltScreen, TuiMainScreen, visibleWidth, getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import patchExtension from "../packages/pi-codex-tools/extensions/index.ts";
import { formatApplyPatchCallText } from "../packages/pi-codex-tools/src/patch-preview.ts";
import webExtension from "../packages/pi-web-kit/extensions/index.ts";
import { registerGoalRenderers } from "../packages/pi-goal/src/rendering.ts";
import { updateGoalUi, clearGoalUi } from "../packages/pi-goal/src/ui.ts";
import dcgExtension from "../packages/pi-dcg/extensions/index.ts";
import insomniaExtension from "../packages/pi-insomnia/extensions/index.ts";
import goalExtension from "../packages/pi-goal/extensions/index.ts";
import { createGoalMutation } from "../packages/pi-goal/src/state.ts";
import { codexHarness, textResponse } from "./codex-harness.mjs";

// Real Pi render shells and both terminal engines. No live executor or provider calls.
process.env.CI = "1";
process.env.PI_OFFLINE = "1";
const profile = await mkdtemp(join(tmpdir(), "pi-tui-contract-"));
process.env.PI_CODING_AGENT_DIR = profile;

function terminal() {
  return {
    columns: 80, rows: 30, kittyProtocolActive: false, output: "",
    start(input, resize) { this.input = input; this.resize = resize; },
    stop() {}, async drainInput() {},
    write(text) { this.output += text; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    setProgramStatus(status) { this.status = status; },
  };
}

async function definitions() {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerFlag() {}, registerCommand() {}, registerShortcut() {},
    on(name, handler) { handlers.set(name, handler); },
    getFlag() {}, getActiveTools: () => [], setActiveTools() {},
  };
  patchExtension(pi);
  webExtension(pi);
  await handlers.get("session_start")({}, { cwd: profile, isProjectTrusted: () => false });
  return tools;
}

function fits(component, width) {
  const lines = component.render(width);
  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  return lines.join("\n");
}

for (const [mode, Engine] of [["regular", TuiMainScreen], ["fullscreen", TuiAltScreen]]) {
  test(`real ${mode} patch shell: themes, partial/error results, expansion, padding and resize`, async () => {
    initTheme("dark", false);
    const tools = await definitions();
    const term = terminal();
    const tui = new Engine(term);
    const definition = tools.get("apply_patch");
    let call;
    const renderer = {
      ...definition,
      renderCall(args, theme, context) {
        const component = definition.renderCall(args, theme, context);
        call = { component, args, theme, expanded: context.expanded };
        return component;
      },
    };
    const assertCurrentPreview = () => {
      const expected = new Text(formatApplyPatchCallText(call.args.patch, call.theme, {
        expanded: call.expanded,
      }), 0, 0).render(80);
      assert.deepEqual(call.component.render(80), expected, "the preview itself must use the current palette, not only the host background");
    };
    const component = new ToolExecutionComponent("apply_patch", "fixture-patch", {
      patch: "*** Begin Patch\n*** Add File: 界-🦊.txt\n+Wide 界 and combining é\n*** End Patch",
    }, { outputPad: 0 }, renderer, tui, profile);
    tui.addChild(component);
    tui.start();
    try {
      const dark = fits(component, 80);
      assertCurrentPreview();
      assert.match(stripVTControlCharacters(dark), /Wide 界/);
      initTheme("light", false);
      tui.invalidate();
      const light = fits(component, 80);
      assertCurrentPreview();
      assert.notEqual(light, dark, "existing cached patch colors must change without a tool call");
      for (const palette of ["system", "dark", "light"]) {
        initTheme(palette, false);
        tui.invalidate();
        assertCurrentPreview();
        for (const width of [12, 40, 120, 24]) {
          term.columns = width;
          term.resize();
          for (const expanded of [true, false]) {
            component.setExpanded(expanded);
            fits(component, width);
            tui.renderNow();
          }
        }
      }
      component.updateResult({ content: [{ type: "text", text: "Partial fixture" }], isError: false }, true);
      fits(component, 40);
      component.updateResult({
        content: [{ type: "text", text: "Cancelled fixture 界" }], isError: true, durationMs: 123,
      });
      assert.match(stripVTControlCharacters(fits(component, 40)), /Cancelled fixture/);
      component.setOutputPad(2);
      const padded = fits(component, 80);
      assert.match(stripVTControlCharacters(padded), /apply_patch/);
      const titleLine = stripVTControlCharacters(padded).split("\n").find(line => line.includes("apply_patch"));
      assert.match(titleLine, /^ {2}apply_patch/, "only the host shell applies outputPad");
      assert.ok(term.output.length > 0, "the actual terminal engine emitted output");
    } finally { tui.stop(); }
  });

  test(`real ${mode} web shell: partial spinner settles and existing result recolors`, async () => {
    initTheme("dark", false);
    const tools = await definitions();
    const term = terminal();
    const tui = new Engine(term);
    const component = new ToolExecutionComponent("web_fetch", "fixture-fetch", {
      url: "https://fixture.invalid/界",
    }, { outputPad: 1 }, tools.get("web_fetch"), tui, profile);
    tui.addChild(component);
    tui.start();
    try {
      component.updateResult({
        content: [{ type: "text", text: "Partial fixture" }], isError: false,
        details: { progress: { kind: "fetch", total: 1, completed: 0,
          items: [{ label: "https://fixture.invalid/界", status: "current" }] } },
      }, true);
      assert.match(stripVTControlCharacters(fits(component, 40)), /Fetching page/);
      component.setExpanded(true);
      const pendingDark = fits(component, 80);
      initTheme("light", false);
      tui.invalidate();
      assert.notEqual(fits(component, 80), pendingDark);
      initTheme("dark", false);
      tui.invalidate();
      fits(component, 40);
      component.updateResult({ content: [{ type: "text", text: "Failed fixture 界" }], isError: true, durationMs: 25 });
      const dark = fits(component, 80);
      initTheme("light", false);
      tui.invalidate();
      assert.notEqual(fits(component, 80), dark);
      for (const width of [12, 40, 120, 24]) {
        term.columns = width;
        term.resize();
        component.setExpanded(true);
        fits(component, width);
        tui.renderNow();
      }
    } finally { tui.stop(); }
  });

  test(`real ${mode} image display uses fixture pixels on Kitty/iTerm2 and text fallback`, () => {
    initTheme("dark", false);
    const previous = getCapabilities();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    try {
      for (const protocol of ["kitty", "iterm2", null]) {
        setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
        const term = terminal();
        const tui = new Engine(term);
        const component = new ToolExecutionComponent("fixture_image", "fixture-image", {},
          { showImages: true, imageWidthCells: 8 }, undefined, tui, profile);
        component.updateResult({ content: [
          { type: "text", text: "Existing image fixture" },
          { type: "image", data: png, mimeType: "image/png" },
        ], isError: false });
        tui.addChild(component);
        tui.start();
        try {
          const rendered = component.render(40).join("\n");
          if (protocol === "kitty") assert.ok(rendered.includes("\x1b_G"));
          if (protocol === "iterm2" && mode === "regular") assert.ok(rendered.includes("\x1b]1337;File="));
          if (protocol === "iterm2" && mode === "fullscreen") {
            assert.equal(getCapabilities().images, null, "Pi disables iTerm2 images in alternate-screen mode");
            assert.ok(!rendered.includes("\x1b]1337;File="));
          }
          if (protocol === null) assert.match(stripVTControlCharacters(rendered), /image/i);
          term.columns = 24;
          term.resize();
          tui.renderNow();
          component.setShowImages(false);
          assert.ok(!component.render(24).join("\n").includes("\x1b_G"));
        } finally { tui.stop(); }
      }
    } finally { setCapabilities(previous); }
  });
}

test("restored goal message renderers wrap wide objectives and use the supplied current palette", () => {
  const renderers = new Map();
  registerGoalRenderers({ registerMessageRenderer: (name, renderer) => renderers.set(name, renderer) });
  for (const renderer of renderers.values()) {
    let previous;
    for (const color of [31, 32, 34]) {
      const theme = { fg: (_token, text) => `\x1b[${color}m${text}\x1b[0m`, bold: text => text };
      const message = { content: "Restored 界 🦊 status", details: {} };
      const component = renderer(message, { expanded: true }, theme);
      const output = fits(component, 40);
      if (previous) assert.notEqual(output, previous);
      previous = output;
    }
  }
});

test("actual session HTML export pre-renders extension tools and escapes fixture markup", async () => {
  initTheme("dark", false);
  const manager = SessionManager.create(profile, join(profile, "sessions"));
  const h = await codexHarness([patchExtension, webExtension], { cwd: profile, sessionManager: manager });
  try {
    manager.appendMessage({ role: "user", content: "Synthetic export fixture", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant", api: h.model.api, provider: h.model.provider, model: h.model.id,
      timestamp: Date.now(), stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: "toolCall", id: "export-patch", name: "apply_patch", arguments: {
          patch: "*** Begin Patch\n*** Add File: 界.txt\n+<script>fixture</script>\n*** End Patch",
        } },
        { type: "toolCall", id: "export-web", name: "web_fetch", arguments: { url: "https://fixture.invalid/界" } },
      ],
    });
    for (const [toolCallId, toolName] of [["export-patch", "apply_patch"], ["export-web", "web_fetch"]]) {
      manager.appendMessage({
        role: "toolResult", toolCallId, toolName, timestamp: Date.now(), isError: true,
        content: [{ type: "text", text: "Cancelled <script>fixture</script>" }], details: {},
      });
    }
    const path = await h.session.exportToHtml(join(profile, "fixture.html"), { themeName: "light" });
    const html = await readFile(path, "utf8");
    const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    assert.ok(encoded);
    const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    for (const id of ["export-patch", "export-web"]) {
      assert.ok(data.renderedTools[id].callHtml);
      assert.ok(data.renderedTools[id].resultHtmlExpanded);
      assert.ok(!JSON.stringify(data.renderedTools[id]).includes("<script>fixture</script>"));
      assert.match(JSON.stringify(data.renderedTools[id]), /&lt;script&gt;/);
    }
  } finally { await h.close(); }
});

test("DCG footer is palette-neutral while RPC approval and notifications remain available", async () => {
  const handlers = new Map();
  const client = {
    async probe() { return { version: "0.6.8" }; },
    async check() { return { decision: "allow" }; },
  };
  dcgExtension({
    on: (name, handler) => handlers.set(name, handler), registerCommand() {},
  }, { client, config: { onError: "block", guardUserBash: false } });
  const statuses = [];
  const ctx = {
    mode: "tui", hasUI: true, cwd: profile,
    ui: { theme: { fg() { throw new Error("must not retain ANSI"); } },
      setStatus: (_name, text) => statuses.push(text), notify() {} },
  };
  await handlers.get("session_start")({}, ctx);
  assert.equal(statuses.at(-1), "\u{f0565}");
  ctx.mode = "rpc";
  ctx.ui.setStatus = () => assert.fail("terminal status in RPC");
  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_shutdown")({}, ctx);
});

test("goal terminal surfaces are absent in print, JSON and RPC modes", () => {
  for (const mode of ["print", "json", "rpc"]) {
    const ctx = { mode, hasUI: mode === "rpc", ui: {
      setStatus: () => assert.fail(`status in ${mode}`),
      setWidget: () => assert.fail(`widget in ${mode}`),
    } };
    updateGoalUi(ctx, null);
    clearGoalUi(ctx);
  }
});

test("insomnia terminal surfaces are absent in print, JSON and RPC modes", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const ctx = { mode, hasUI: mode === "rpc", ui: {
      setStatus: () => assert.fail(`status in ${mode}`),
    } };
    const handlers = new Map();
    insomniaExtension({ on: (name, handler) => handlers.set(name, handler) }, {
      acquire: () => true, release() {}, forceStop() {}, isInhibiting: false,
    });
    await handlers.get("agent_start")({}, ctx);
    await handlers.get("agent_settled")({}, ctx);
    await handlers.get("session_shutdown")({}, ctx);
  }
});

function footerBindings(statuses, notifications = []) {
  return { mode: "tui", uiContext: {
    setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
    setWidget() {},
    notify: (message, type) => notifications.push({ message, type }),
  } };
}

function checkNativeFooter(h, statuses, key, expected) {
  assert.equal(statuses.get(key), expected);
  const footer = new FooterComponent(h.session, {
    getGitBranch: () => null,
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
  });
  for (const palette of ["dark", "light", "system"]) {
    initTheme(palette, false);
    for (const width of [1, 3, 12, 40, 100]) {
      const lines = footer.render(width);
      assert.equal(lines.length, expected === undefined ? 2 : 3);
      if (expected !== undefined) {
        assert.ok(visibleWidth(lines[2]) <= width);
        if (width >= visibleWidth(expected)) assert.equal(lines[2], expected);
      }
    }
  }
  if (expected !== undefined) {
    statuses.set("a-neighbor", "before");
    statuses.set("z-neighbor", "after");
    assert.equal(stripVTControlCharacters(footer.render(100)[2]), `before ${expected} after`);
    statuses.delete("a-neighbor");
    statuses.delete("z-neighbor");
  }
}

test("real Pi insomnia lifecycle publishes one coffee icon and clears it on settle/shutdown", async (t) => {
  const statuses = new Map();
  let inhibiting = false;
  const inhibitor = {
    acquire() { inhibiting = true; return true; },
    release() { inhibiting = false; },
    forceStop() { inhibiting = false; },
    get isInhibiting() { return inhibiting; },
  };
  const h = await codexHarness([pi => insomniaExtension(pi, inhibitor)], {
    bindings: footerBindings(statuses),
  });
  try {
    t.mock.method(globalThis, "fetch", async () => {
      assert.equal(inhibiting, true);
      checkNativeFooter(h, statuses, "pi-insomnia", "\u{f0176}");
      return textResponse();
    });
    await h.session.prompt("Synthetic insomnia footer smoke test");
    assert.equal(inhibiting, false);
    checkNativeFooter(h, statuses, "pi-insomnia", undefined);
    await h.session.extensionRunner.emit({ type: "agent_start" });
    checkNativeFooter(h, statuses, "pi-insomnia", "\u{f0176}");
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(inhibiting, false);
    checkNativeFooter(h, statuses, "pi-insomnia", undefined);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const [onError, policy] of [["allow", "fail-open"], ["block", "blocking"]]) {
  test(`real Pi DCG health footer retains ${policy} and recovers through /dcg`, async () => {
    const statuses = new Map();
    const notifications = [];
    let failed = false;
    let h;
    const client = {
      async probe() {
        if (h) checkNativeFooter(h, statuses, "pi-dcg", "\u{f0d9a}");
        if (failed) throw new Error("Synthetic unavailable DCG");
        return { version: "0.6.8" };
      },
    };
    h = await codexHarness([pi => dcgExtension(pi, { client, config: { onError, guardUserBash: false } })], {
      bindings: footerBindings(statuses, notifications),
    });
    try {
      await h.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
      checkNativeFooter(h, statuses, "pi-dcg", "\u{f0565}");
      failed = true;
      await h.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
      checkNativeFooter(h, statuses, "pi-dcg", `\u{f099e} ${policy}`);
      assert.match(notifications.at(-1).message, onError === "allow" ? /allowed \(fail-open\)/ : /blocked/);
      failed = false;
      // /dcg probes directly without first publishing the startup checking state.
      client.probe = async () => ({ version: "0.6.8" });
      await h.session.prompt("/dcg");
      checkNativeFooter(h, statuses, "pi-dcg", "\u{f0565}");
      assert.match(notifications.at(-1).message, /Version: 0\.6\.8/);
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      checkNativeFooter(h, statuses, "pi-dcg", undefined);
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

test("real Pi goal restoration renders all six states with budgets and clears through /goal", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider request"); });
  const statuses = new Map();
  const h = await codexHarness([goalExtension], { bindings: footerBindings(statuses) });
  // Do not launch automatic activation turns while inspecting restored UI state.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const create = createGoalMutation("Synthetic footer fixture", 50_000);
    h.sessionManager.appendCustomEntry("pi-goal", create);
    h.sessionManager.appendCustomEntry("pi-goal", {
      schemaVersion: 1, kind: "account", goalId: create.goalId, at: create.at,
      tokens: 12_000, entryIds: ["synthetic-usage"],
    });
    for (const [status, icon] of Object.entries({
      active: "\u{f040a}", paused: "\u{f03e4}", blocked: "\u{f033e}",
      usage_limited: "\u{f051f}", budget_limited: "\u{f0199}", complete: "\u{f012c}",
    })) {
      h.sessionManager.appendCustomEntry("pi-goal", {
        schemaVersion: 1, kind: "status", goalId: create.goalId, at: create.at, status,
      });
      await h.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
      checkNativeFooter(h, statuses, "pi-goal", `\u{f08c9} ${icon} 12k/50k`);
    }
    await h.session.prompt("/goal clear");
    checkNativeFooter(h, statuses, "pi-goal", undefined);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await h.close();
  }
});

test.after(async () => { await rm(profile, { recursive: true, force: true }); });
