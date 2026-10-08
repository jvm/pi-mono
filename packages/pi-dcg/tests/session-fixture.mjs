import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { codexHarness, requestBody, textResponse } from "../../../tests/codex-harness.mjs";
import piDcg from "../extensions/index.ts";
import { DcgClient } from "../src/dcg-client.ts";

export const COMMAND = "printf fixture";
export const SECOND_COMMAND = "printf second-fixture";
export const textOf = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function hookResponse(decision, fields = {}) {
  return {
    stdout: JSON.stringify({ hookSpecificOutput: {
      permissionDecision: decision, permissionDecisionReason: "Reason: fixture policy", ...fields,
    } }),
    stderr: "",
    exitCode: 0,
  };
}

export function onBash(handler) {
  return pi => pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "bash") return handler(event, ctx);
  });
}

function callResponse(name, args, custom, id) {
  const item = custom
    ? { type: "custom_tool_call", id: `ct_${id}`, call_id: `call_${id}`, name, input: args }
    : { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(custom ? { input: "" } : { arguments: "" }) } },
    { type: custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
      output_index: 0, item_id: item.id, delta: custom ? args : JSON.stringify(args) },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Real Pi + real DCG client/parser; only provider, process, shell and UI boundaries are mocked. */
export async function fixture(t, options = {}) {
  const profile = await mkdtemp(join(tmpdir(), "pi-dcg-contract-"));
  const envKeys = ["CI", "PI_OFFLINE", "PI_TELEMETRY", "PI_CODING_AGENT_DIR"];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CI: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: profile });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unmocked network blocked"); };
  const checks = [];
  const executed = [];
  const calls = [];
  const results = [];
  const events = [];
  const notifications = [];
  const confirmations = [];
  const definitions = [];
  const config = { binary: "unused-fixture", timeoutMs: 1000, maxOutputBytes: 1024,
    onError: "allow", guardUserBash: true, ...options.config };
  const client = new DcgClient(config, async request => {
    if (request.args[0] === "--version") return { stdout: "dcg 0.6.8", stderr: "", exitCode: 0 };
    const payload = JSON.parse(request.input);
    const check = { command: payload.tool_input.command, request };
    checks.push(check);
    return options.process ? options.process(check) : hookResponse(options.decision ?? "allow");
  }, {});
  let h;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (h) {
        await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await h.session.abort();
        await h.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(profile, { recursive: true, force: true });
    }
  }
  t.after(close);
  const shell = pi => pi.on("session_start", (_event, ctx) => {
    const definition = createBashToolDefinition(ctx.cwd, {
      operations: { async exec(command, cwd, { onData, signal }) {
        executed.push({ command, cwd, signal });
        onData(Buffer.from("fixture output\n"));
        return { exitCode: 0 };
      } },
    });
    const wrapped = options.wrapShell ? options.wrapShell(definition) : definition;
    definitions.push(wrapped);
    pi.registerTool(wrapped);
  });
  try {
    h = await codexHarness([
      ...(options.mode === "off" ? [] : [createCodemodeExtension({ mode: options.mode ?? "only" })]),
      ...(!options.shellLast ? [shell] : []),
      pi => {
        pi.on("tool_call", event => {
          if (event.toolName === "bash") calls.push({ ...event, input: { ...event.input } });
        });
        pi.on("tool_result", event => { if (event.toolName === "bash") results.push(event); });
        pi.registerTool({
          name: "fixture_orchestrator", label: "Fixture", description: "Exercise nested dispatch.",
          exposure: "model-only", parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute(_id, _args, _signal, _update, ctx) {
            if (options.orchestrate) return options.orchestrate(ctx);
            const outcome = await ctx.executeTool("bash", { command: COMMAND });
            return { ...outcome.result, isError: outcome.isError };
          },
        });
      },
      ...(options.before ?? []),
      ...(options.omitDcg ? [] : [pi => piDcg(pi, { client, config })]),
      ...(options.after ?? []),
      ...(options.shellLast ? [shell] : []),
    ], {
      defaultTools: ["bash", ...(options.mode === "off" ? [] : ["codemode"])],
      ...(options.tools ? { tools: options.tools } : {}),
    });
    h.session.subscribe(event => {
      if (event.toolName === "bash" && event.type.startsWith("tool_execution_")) events.push(event);
    });
    if (options.uiMode) {
      await h.session.bindExtensions({
        mode: options.uiMode,
        uiContext: {
          theme: { fg: (_color, text) => text },
          notify(message, type) { notifications.push({ message, type }); },
          setStatus() {},
          confirm(title, message, opts) {
            confirmations.push({ title, message, opts });
            return options.confirm ? options.confirm(title, message, opts) : Promise.resolve(false);
          },
        },
        onError: error => h.errors.push(error),
      });
    }
  } catch (error) {
    await close();
    throw error;
  }
  let nextCall;
  let nextId = 0;
  globalThis.fetch = async (_url, init) => {
    const body = requestBody(init);
    assert.ok(Array.isArray(body.input), "only synthetic chat requests are expected");
    if (!nextCall) return textResponse();
    const [name, args] = nextCall;
    nextCall = undefined;
    const custom = body.tools.find(tool => tool.name === name)?.type === "custom";
    return callResponse(name, name === "codemode" && !custom ? { code: args } : args, custom, ++nextId);
  };
  const run = async (name, args) => {
    nextCall = [name, args];
    await h.session.prompt("Exercise synthetic DCG contract.");
    return h.session.messages.findLast(message => message.role === "toolResult");
  };
  return {
    ...h, checks, executed, calls, results, events, notifications, confirmations, definitions, close, run,
    script: (code = `text(await tools.bash({ command: ${JSON.stringify(COMMAND)} }));`) => run("codemode", code),
    direct: () => run("bash", { command: COMMAND }),
    probe: () => run("fixture_orchestrator", {}),
  };
}
