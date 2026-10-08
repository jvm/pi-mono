import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { DcgProcessError } from "../src/dcg-client.ts";
import { COMMAND, SECOND_COMMAND, deferred, fixture, hookResponse, onBash, textOf } from "./session-fixture.mjs";

// Top-level tests are sequential: each fixture owns fetch and its disposable profile.
for (const mode of ["off", "on", "only", "orchestrator"]) {
  for (const decision of ["allow", "deny", "ask"]) {
    test(`real session ${mode}: ${decision}`, async t => {
      const h = await fixture(t, { mode: mode === "orchestrator" ? "only" : mode, decision });
      const result = mode === "off" ? await h.direct() : mode === "orchestrator" ? await h.probe() : await h.script();
      assert.equal(h.checks.length, 1);
      assert.equal(h.checks[0].request.cwd, h.ctx.cwd);
      assert.equal(h.executed.length, decision === "allow" ? 1 : 0);
      assert.equal(result.isError, decision !== "allow");
      assert.deepEqual(h.errors, []);
      if (decision === "allow") {
        assert.equal(h.executed[0].command, h.checks[0].command);
        assert.equal(h.executed[0].cwd, h.checks[0].request.cwd);
      } else {
        assert.match(textOf(result), decision === "deny" ? /Blocked by dcg/ : /No interactive UI/);
      }
      // Pi does not emit tool_result for a pre-execution block.
      assert.equal(h.results.length, decision === "allow" ? 1 : 0);
      const call = h.calls[0];
      const end = h.events.find(event => event.type === "tool_execution_end");
      assert.equal(end.toolCallId, call.toolCallId);
      assert.equal(end.isError, decision !== "allow");
      if (mode !== "off") {
        assert.equal(call.parentToolCallId, result.toolCallId);
        assert.ok(call.toolCallId.startsWith(`${result.toolCallId}/`));
        assert.equal(end.parentToolCallId, result.toolCallId);
        assert.equal(result.nestedCalls.calls[0].id, call.toolCallId);
        assert.equal(result.nestedCalls.calls[0].status, decision === "allow" ? "ok" : "error");
        assert.ok(!h.session.messages.some(message => message.role === "toolResult" && message.toolCallId === call.toolCallId));
      }
    });
  }
}

test("negative control: removing the DCG factory makes the same nested call execute", async t => {
  const h = await fixture(t, { omitDcg: true, decision: "deny" });
  const result = await h.script();
  assert.equal(result.isError, false);
  assert.equal(h.checks.length, 0);
  assert.equal(h.executed.length, 1);
});

for (const uiMode of ["tui", "rpc"]) {
  for (const approved of [true, false]) {
    test(`${uiMode} ask approval=${approved} uses the checked command and passes a signal`, async t => {
      const h = await fixture(t, { decision: "ask", uiMode, confirm: async () => approved });
      const result = await h.script();
      assert.equal(result.isError, !approved);
      assert.equal(h.executed.length, approved ? 1 : 0);
      assert.equal(h.confirmations.length, 1);
      assert.ok(h.confirmations[0].message.includes(h.checks[0].command));
      assert.equal(h.confirmations[0].opts.signal, h.checks[0].request.signal);
      if (approved) assert.equal(h.executed[0].command, h.checks[0].command);
    });
  }
}

test("hard denial never asks; only the UI receives manual authorization guidance", async t => {
  const h = await fixture(t, {
    uiMode: "tui", confirm: async () => true,
    process: async () => hookResponse("deny", { allowOnceCode: "fixture-code" }),
  });
  const result = await h.script();
  assert.equal(h.executed.length, 0);
  assert.equal(h.confirmations.length, 0);
  assert.doesNotMatch(textOf(result), /allow-once|fixture-code/);
  assert.doesNotMatch(result.nestedCalls.calls[0].error, /allow-once|fixture-code/);
  assert.ok(h.notifications.some(({ message }) => message.includes("dcg allow-once fixture-code")));
});

for (const [name, process] of [
  ["malformed JSON", async () => ({ stdout: "{invalid", stderr: "", exitCode: 0 })],
  ["unknown decision", async () => hookResponse("unknown")],
  ["nonzero exit", async () => ({ stdout: "", stderr: "private-fixture-stderr", exitCode: 4 })],
  ["timeout", async () => { throw new DcgProcessError("fixture timeout", "timed_out"); }],
  ["spawn failure", async () => { throw new DcgProcessError("fixture spawn failure", "spawn_failed"); }],
  ["output limit", async () => { throw new DcgProcessError("fixture output limit", "output_limit"); }],
]) {
  for (const onError of ["allow", "block"]) {
    test(`${name}: configured ${onError} posture survives nested dispatch`, async t => {
      const h = await fixture(t, { process, config: { onError }, uiMode: "tui" });
      const result = await h.script();
      assert.equal(h.executed.length, onError === "allow" ? 1 : 0);
      assert.equal(result.isError, onError === "block");
      assert.equal(h.confirmations.length, 0);
      assert.doesNotMatch(textOf(result), /private-fixture-stderr/);
      assert.ok(h.notifications.every(({ message }) => !message.includes("private-fixture-stderr")));
      if (onError === "allow") assert.equal(h.executed[0].command, h.checks[0].command);
    });
  }
}

for (const kind of ["command", "input", "exception"]) {
  test(`later ${kind} change blocks before shell execution`, async t => {
    const h = await fixture(t, { after: [onBash(event => {
      if (kind === "command") event.input.command = SECOND_COMMAND;
      else if (kind === "input") event.input = { command: SECOND_COMMAND };
      else throw new Error("fixture hook exception");
    })] });
    const result = await h.script();
    assert.equal(h.checks.length, 1);
    assert.equal(h.executed.length, 0);
    assert.equal(result.isError, true);
    assert.match(textOf(result), kind === "exception" ? /fixture hook exception/ : /pi-dcg blocked/);
  });
}

test("an earlier in-place mutation is checked and executed unchanged", async t => {
  const h = await fixture(t, { before: [onBash(event => { event.input.command = SECOND_COMMAND; })] });
  await h.script();
  assert.equal(h.checks[0].command, SECOND_COMMAND);
  assert.equal(h.executed[0].command, SECOND_COMMAND);
});

for (const approvalFirst of [true, false]) {
  for (const block of [true, false]) {
    test(`other approval hook first=${approvalFirst} blocks=${block}`, async t => {
      let approvals = 0;
      const approval = onBash(() => {
        approvals++;
        if (block) return { block: true, reason: "fixture approval denied" };
      });
      const h = await fixture(t, { [approvalFirst ? "before" : "after"]: [approval] });
      const result = await h.script();
      assert.equal(approvals, 1);
      assert.equal(h.checks.length, approvalFirst && block ? 0 : 1);
      assert.equal(h.executed.length, block ? 0 : 1);
      assert.equal(result.isError, block);
    });
  }
}

test("an earlier hook exception fails closed even with bridge errors allowed", async t => {
  const h = await fixture(t, { before: [onBash(() => { throw new Error("fixture earlier failure"); })] });
  const result = await h.script();
  assert.equal(h.checks.length, 0);
  assert.equal(h.executed.length, 0);
  assert.match(textOf(result), /fixture earlier failure/);
});

for (const shellLast of [false, true]) {
  test(`native execution wrapper survives registration order shellLast=${shellLast} and reload`, async t => {
    let approvals = 0;
    const h = await fixture(t, {
      shellLast,
      wrapShell: definition => ({ ...definition, async execute() {
        approvals++;
        throw new Error("fixture executor approval denied");
      } }),
    });
    for (let run = 0; run < 2; run++) {
      if (run) await h.session.reload();
      const result = await h.script();
      assert.match(textOf(result), /fixture executor approval denied/);
    }
    assert.equal(approvals, 2);
    assert.equal(h.checks.length, 2);
    assert.equal(h.executed.length, 0);
  });
}

for (const mode of ["on", "only"]) {
  test(`explicit tool selection excluding bash stays excluded in ${mode}, including reload`, async t => {
    const h = await fixture(t, { mode, tools: ["codemode", "fixture_orchestrator"] });
    for (let run = 0; run < 2; run++) {
      if (run) await h.session.reload();
      const result = await h.script('text(await describeTool("bash")); text(ALL_TOOLS.some(tool => tool.name === "bash")); await tools.bash({command:"printf fixture"});');
      assert.equal(result.isError, true);
      assert.match(textOf(result), /false/);
      assert.ok(!h.session.getCallableToolNames().includes("bash"));
      assert.equal((await h.probe()).isError, true);
    }
    assert.equal(h.checks.length, 0);
    assert.equal(h.executed.length, 0);
  });
}

test("parallel checks finish independently with no shared policy decision", async t => {
  const first = deferred();
  const bothChecked = deferred();
  let checks = 0;
  const h = await fixture(t, { process: async ({ command }) => {
    if (++checks === 2) bothChecked.resolve();
    if (command === COMMAND) await first.promise;
    return hookResponse(command === COMMAND ? "deny" : "allow");
  } });
  t.after(() => first.resolve());
  const running = h.script(`text(await Promise.allSettled([tools.bash({command:${JSON.stringify(COMMAND)}}), tools.bash({command:${JSON.stringify(SECOND_COMMAND)}})]));`);
  await bothChecked.promise;
  await tick();
  assert.equal(h.executed.length, 1, "an allowed sibling must not wait for the first policy check");
  first.resolve();
  const result = await running;
  assert.deepEqual(h.executed.map(call => call.command), [SECOND_COMMAND]);
  assert.deepEqual(result.nestedCalls.calls.map(call => call.status), ["error", "ok"]);
  assert.equal(new Set(h.calls.map(call => call.toolCallId)).size, 2);
});

/** Model the documented dialog signal contract; individual tests also exercise the real TUI. */
function dialogs({ ignoreAbort = false } = {}) {
  const entries = [];
  const arrivals = [];
  let active = 0;
  let maxActive = 0;
  return {
    entries,
    get active() { return active; },
    get maxActive() { return maxActive; },
    opened(index) {
      if (entries[index]) return Promise.resolve(entries[index]);
      arrivals[index] ??= deferred();
      return arrivals[index].promise;
    },
    confirm(_title, message, { signal }) {
      const pending = deferred();
      active++;
      maxActive = Math.max(active, maxActive);
      const onAbort = () => pending.resolve(false);
      if (!ignoreAbort) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const entry = { message, signal, resolve: pending.resolve, reject: pending.reject };
      entries.push(entry);
      arrivals[entries.length - 1]?.resolve(entry);
      return pending.promise.finally(() => {
        signal.removeEventListener("abort", onAbort);
        active--;
      });
    },
  };
}

test("parallel ask calls queue distinct approvals; a rejected dialog does not poison the queue", async t => {
  const ui = dialogs();
  const h = await fixture(t, { decision: "ask", uiMode: "tui", confirm: ui.confirm });
  const running = h.script(`text(await Promise.allSettled([tools.bash({command:${JSON.stringify(COMMAND)}}), tools.bash({command:${JSON.stringify(SECOND_COMMAND)}})]));`);
  (await ui.opened(0)).reject(new Error("fixture UI failure"));
  const second = await ui.opened(1);
  assert.ok(second.message.includes(SECOND_COMMAND));
  second.resolve(true);
  const result = await running;
  assert.equal(ui.maxActive, 1);
  assert.deepEqual(h.executed.map(call => call.command), [SECOND_COMMAND]);
  assert.deepEqual(result.nestedCalls.calls.map(call => call.status), ["error", "ok"]);
});

for (const path of ["direct", "script", "probe"]) {
  test(`turn abort cancels active and queued confirmations through ${path}`, { timeout: 5000 }, async t => {
    const ui = dialogs();
    const h = await fixture(t, { mode: "on", decision: "ask", uiMode: "tui", confirm: ui.confirm });
    const running = path === "script"
      ? h.script(`text(await Promise.allSettled([tools.bash({command:${JSON.stringify(COMMAND)}}), tools.bash({command:${JSON.stringify(SECOND_COMMAND)}})]));`)
      : h[path]();
    const first = await ui.opened(0);
    await h.session.abort();
    await running;
    await tick();
    assert.equal(first.signal.aborted, true);
    assert.equal(ui.active, 0);
    assert.equal(ui.entries.length, 1, "queued confirmation must not open after cancellation");
    assert.equal(h.executed.length, 0);
  });
}

test("late approval from a UI that ignores abort cannot approve a later turn", { timeout: 5000 }, async t => {
  const ui = dialogs({ ignoreAbort: true });
  const h = await fixture(t, { mode: "on", decision: "ask", uiMode: "tui", confirm: ui.confirm });
  const firstRun = h.direct();
  const first = await ui.opened(0);
  await h.session.abort();
  await firstRun;
  const secondRun = h.direct();
  const second = await ui.opened(1);
  first.resolve(true);
  await tick();
  assert.equal(h.executed.length, 0);
  second.resolve(false);
  await secondRun;
  assert.equal(h.executed.length, 0);
});

for (const completion of ["cancel-error", "late-allow", "late-error"]) {
  test(`cancellation during checking blocks ${completion}, even when bridge errors are allowed`, { timeout: 5000 }, async t => {
    const entered = deferred();
    const pending = deferred();
    const h = await fixture(t, { process: ({ request }) => {
      request.signal.addEventListener("abort", () => {
        if (completion === "late-allow") pending.resolve(hookResponse("allow"));
        else pending.reject(completion === "cancel-error"
          ? new DcgProcessError("fixture cancelled", "aborted") : new Error("fixture unrelated error"));
      }, { once: true });
      entered.resolve(request.signal);
      return pending.promise;
    } });
    const running = h.script();
    const signal = await entered.promise;
    await h.session.abort();
    await running;
    await tick();
    assert.equal(signal.aborted, true);
    assert.equal(h.executed.length, 0);
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.notifications.length, 0);
  });
}

test("reload cancels idle user confirmations and creates a fresh confirmation queue", { timeout: 5000 }, async t => {
  const ui = dialogs();
  const h = await fixture(t, { mode: "on", decision: "ask", uiMode: "tui", confirm: ui.confirm });
  const user = command => h.session.extensionRunner.emitUserBash({
    type: "user_bash", command, cwd: h.ctx.cwd, excludeFromContext: false,
  });
  const first = user(COMMAND);
  const second = user(SECOND_COMMAND);
  const opened = await ui.opened(0);
  await h.session.reload();
  const outcomes = await Promise.all([first, second]);
  assert.ok(outcomes.every(outcome => outcome.result.exitCode === 1));
  assert.ok(outcomes.every(outcome => /cancelled/.test(outcome.result.output)));
  assert.equal(opened.signal.aborted, true);
  assert.equal(ui.entries.length, 1);
  const fresh = h.direct();
  (await ui.opened(1)).resolve(true);
  assert.equal((await fresh).isError, false);
  assert.equal(h.executed.length, 1);
});

test("Pi 1.1.0 limitation: replacing input before DCG detaches it from execution args", async t => {
  // Characterization, not a passing security guarantee. Remove this limitation
  // only with an upstream fix and a regression that enforces argument identity.
  const h = await fixture(t, {
    before: [onBash(event => { event.input = { command: SECOND_COMMAND }; })],
    process: async ({ command }) => hookResponse(command === COMMAND ? "deny" : "allow"),
  });
  await h.script();
  assert.equal(h.checks[0].command, SECOND_COMMAND);
  assert.equal(h.executed[0].command, COMMAND);
});
