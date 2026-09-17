import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Container } from "@earendil-works/pi-tui";
import { codexHarness, compactionResponse, requestBody, textResponse } from "../../../tests/codex-harness.mjs";
import compaction from "../extensions/index.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";

// Exercise Pi's real chat rebuild and renderers, not a copied simulation.
// Private access is test-only; production uses documented extension APIs.
const piRoot = new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { InteractiveMode } = await import(new URL("modes/interactive/interactive-mode.js", piRoot));
const { initTheme } = await import(new URL("modes/interactive/theme/theme.js", piRoot));
initTheme("dark");
const savedType = "pi-codex-compaction:saved:v1";
const notice = "[compaction (codex)] Checkpoint saved.";

for (const reason of ["manual", "threshold", "overflow"]) {
  test(`Codex confirmation survives real Pi ${reason} compaction, redraw, and restoration`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => compactionResponse());
    const h = await codexHarness([compaction]);
    try {
      // Avoid starting a terminal or watchers. Keep the actual event handler,
      // session-entry conversion, custom-entry rendering, and chat container.
      const view = Object.assign(Object.create(InteractiveMode.prototype), {
        isInitialized: true,
        runtimeHost: { session: h.session },
        chatContainer: new Container(),
        pendingTools: new Map(),
        compactionQueuedMessages: [],
        ui: { requestRender() {}, terminal: { setProgress() {} } },
        footer: { invalidate() {} },
        toolOutputExpanded: false,
        outputPad: 1,
        mermaidMarkdownTransformer: (text) => text,
      });
      await h.session.bindExtensions({
        mode: "tui",
        uiContext: { notify: (message, level) => view.showExtensionNotify(message, level) },
        onError: (error) => h.errors.push(error),
      });
      assert.equal(h.session.extensionRunner.createContext().hasUI, true);
      const renders = [];
      const unsubscribe = h.session.subscribe((event) => {
        if (event.type === "compaction_end") renders.push(view.handleEvent(event));
      });
      t.after(unsubscribe);
      let sawTransientNotice = false;
      h.api.on("session_compact", (_event, ctx) => {
        ctx.ui.notify("TRANSIENT SENTINEL", "info");
        sawTransientNotice = view.chatContainer.render(100).join("\n").includes("TRANSIENT SENTINEL");
      });
      for (const [index, content] of ["old request", "kept request"].entries()) {
        h.sessionManager.appendMessage({ role: "user", content, timestamp: index + 1 });
      }
      if (reason === "manual") await h.session.compact();
      else await h.session._runAutoCompaction(reason, reason === "overflow");
      await Promise.all(renders);
      assert.equal(renders.length, 1, "the actual compaction_end handler ran");
      assert.equal(sawTransientNotice, true);

      const assertVisible = () => {
        const screen = stripVTControlCharacters(view.chatContainer.render(100).join("\n"));
        assert.equal(screen.split(notice).length - 1, 1, screen);
        assert.match(screen, /Compacted from/);
        assert.doesNotMatch(screen, /TRANSIENT SENTINEL|fixture-checkpoint/);
      };
      assertVisible();
      view.rebuildChatFromMessages();
      assertVisible();
      // A new extension instance restores its renderer with no in-memory notice state.
      await h.session.reload();
      view.rebuildChatFromMessages();
      assertVisible();
      const entries = h.sessionManager.getBranch().filter((entry) => entry.customType === savedType);
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0].data, { version: 1 });
      assert.doesNotMatch(JSON.stringify(h.sessionManager.buildSessionContext().messages), /Checkpoint saved|saved:v1/);

      // Verify the provider request too, not just SessionManager's context builder.
      let request;
      t.mock.method(globalThis, "fetch", async (_url, init) => {
        request = requestBody(init);
        return textResponse();
      });
      await h.session.prompt("continue", { expandPromptTemplates: false });
      assert.ok(request.input.some((item) => item.type === "compaction"));
      assert.doesNotMatch(JSON.stringify(request), /Checkpoint saved|saved:v1/);

      // A later standard compaction must not create another Codex confirmation.
      t.mock.method(globalThis, "fetch", async () => textResponse("standard summary"));
      await h.session.compact("Focus on recent work");
      await Promise.all(renders);
      assert.equal(h.sessionManager.getBranch().filter((entry) => entry.customType === savedType).length, 1);
      assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction").fromHook, false);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  });
}
