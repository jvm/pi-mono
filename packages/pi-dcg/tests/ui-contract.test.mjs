import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { COMMAND, SECOND_COMMAND, deferred, fixture, hookResponse, onBash } from "./session-fixture.mjs";

/** Isolate private Pi TUI calls here; production DCG uses only public APIs. */
function selectorHarness() {
  initTheme("dark", false);
  const selectors = [];
  const arrivals = [];
  const owner = Object.assign(Object.create(InteractiveMode.prototype), {
    editor: {},
    editorContainer: { clear() {}, addChild() {} },
    programStatus: { setBlocked() {} },
    ui: {
      requestRender() {},
      setFocus(component) {
        if (component === owner.editor) return;
        selectors.push(component);
        arrivals[selectors.length - 1]?.resolve(component);
      },
    },
  });
  return {
    owner, selectors,
    confirm: (title, message, options) => owner.showExtensionConfirm(title, message, options),
    opened(index) {
      if (selectors[index]) return Promise.resolve(selectors[index]);
      arrivals[index] ??= deferred();
      return arrivals[index].promise;
    },
  };
}

test("real Pi selector smoke: parallel approvals stay visible and independently actionable", { timeout: 5000 }, async t => {
  const ui = selectorHarness();
  const h = await fixture(t, { decision: "ask", uiMode: "tui", confirm: ui.confirm });
  const running = h.script(`text(await Promise.allSettled([tools.bash({command:${JSON.stringify(COMMAND)}}), tools.bash({command:${JSON.stringify(SECOND_COMMAND)}})]));`);
  const first = await ui.opened(0);
  await tick();
  assert.equal(ui.selectors.length, 1, "the second confirmation must not replace the first");
  assert.equal(ui.owner.extensionSelector, first);
  assert.ok(stripVTControlCharacters(first.render(80).join("\n")).includes(COMMAND));
  first.handleInput("\n"); // Yes on the actual Pi selector.
  const second = await ui.opened(1);
  assert.equal(ui.owner.extensionSelector, second);
  assert.ok(stripVTControlCharacters(second.render(80).join("\n")).includes(SECOND_COMMAND));
  second.handleInput("j"); // No, then confirm.
  second.handleInput("\n");
  const result = await running;
  assert.deepEqual(h.executed.map(call => call.command), [COMMAND]);
  assert.deepEqual(result.nestedCalls.calls.map(call => call.status), ["ok", "error"]);
  assert.equal(ui.owner.extensionSelector, undefined);
});

test("real Pi selector smoke: turn abort dismisses a direct bash confirmation", { timeout: 5000 }, async t => {
  const ui = selectorHarness();
  const h = await fixture(t, { mode: "on", decision: "ask", uiMode: "tui", confirm: ui.confirm });
  const running = h.direct();
  await ui.opened(0);
  await h.session.abort();
  await running;
  assert.equal(ui.owner.extensionSelector, undefined);
  assert.equal(h.executed.length, 0);
});

test("Pi 1.1.0 limitation: another extension's concurrent dialog is not in DCG's queue", { timeout: 5000 }, async t => {
  const ui = selectorHarness();
  const h = await fixture(t, {
    uiMode: "tui", confirm: ui.confirm,
    process: async ({ command }) => hookResponse(command === COMMAND ? "ask" : "allow"),
    before: [onBash(async (event, ctx) => {
      if (event.input.command !== SECOND_COMMAND) return;
      const approved = await ctx.ui.confirm("Other fixture approval", SECOND_COMMAND, { signal: ctx.signal });
      if (!approved) return { block: true, reason: "Other fixture approval denied" };
    })],
  });
  const running = h.script(`text(await Promise.allSettled([tools.bash({command:${JSON.stringify(COMMAND)}}), tools.bash({command:${JSON.stringify(SECOND_COMMAND)}})]));`);
  await ui.opened(1);
  // This characterizes a host limitation, not an accepted safety guarantee:
  // two extension dialogs exist, but only the last one occupies the editor.
  assert.equal(ui.selectors.length, 2);
  assert.equal(ui.owner.extensionSelector, ui.selectors[1]);
  assert.equal(h.executed.length, 0, "displacing a dialog must not approve either call");
  await h.session.abort();
  await running;
  assert.equal(ui.owner.extensionSelector, undefined);
  assert.equal(h.executed.length, 0);
});

for (const excludeFromContext of [false, true]) {
  for (const kind of ["allow", "deny", "ask", "hook-error", "earlier-result", "disabled"]) {
    test(`real Pi user ${excludeFromContext ? "!!" : "!"}: ${kind}`, async t => {
      const executions = [];
      const operations = {
        async exec(command, cwd, { onData }) {
          executions.push({ command, cwd });
          onData(Buffer.from("fixture user output"));
          return { exitCode: 0 };
        },
      };
      const h = await fixture(t, {
        decision: kind === "deny" || kind === "earlier-result" ? "deny" : kind === "ask" ? "ask" : "allow",
        config: { guardUserBash: kind !== "disabled" },
        before: kind === "earlier-result" ? [pi => pi.on("user_bash", () => ({
          result: { output: "fixture handled", exitCode: 0, cancelled: false, truncated: false },
        }))] : [],
        after: [pi => pi.on("user_bash", () => {
          if (kind === "hook-error") throw new Error("fixture user hook error");
          return { operations };
        })],
      });
      initTheme("dark", false);
      const owner = {
        session: h.session,
        sessionManager: h.sessionManager,
        ui: { requestRender() {} },
        chatContainer: { addChild() {} },
        outputPad: 0,
        showError(message) { assert.fail(message); },
      };
      // This is the actual TUI entry point for !/!!, not session.executeBash(),
      // which intentionally also supports an unguarded RPC control-channel path.
      await InteractiveMode.prototype.handleBashCommand.call(owner, COMMAND, excludeFromContext);
      assert.equal(executions.length, kind === "allow" || kind === "disabled" ? 1 : 0);
      assert.equal(h.checks.length, kind === "earlier-result" || kind === "disabled" ? 0 : 1);
      assert.equal(h.errors.length, kind === "hook-error" ? 1 : 0);
      if (executions.length) {
        assert.equal(executions[0].command, COMMAND);
        assert.equal(executions[0].cwd, h.ctx.cwd);
      }
      if (kind !== "hook-error") {
        const result = h.session.messages.findLast(message => message.role === "bashExecution");
        assert.equal(result.excludeFromContext, excludeFromContext);
        assert.equal(result.exitCode, kind === "deny" || kind === "ask" ? 1 : 0);
      }
    });
  }
}
