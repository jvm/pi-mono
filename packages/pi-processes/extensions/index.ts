import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { ProcessRuntime, resolveWorkdir, type ProcessResult } from "../src/runtime.js";
import { ConfirmationQueue } from "../src/confirmation-queue.js";

const SessionId = Type.String({ minLength: 1, maxLength: 64 });
const Yield = Type.Optional(Type.Integer({ minimum: 0, maximum: 300_000 }));
const Budget = Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000 }));
const ResultSchema = Type.Object({
  session_id: SessionId,
  status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
  exit_code: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  output: Type.String(),
  dropped_bytes: Type.Integer(),
  unread_bytes: Type.Integer(),
  timed_out: Type.Boolean(),
});

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function result(value: ProcessResult) {
  const data = { ...value, output: clean(value.output) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    details: data, structuredContent: data,
  };
}

function maxBytes(tokens = 4_000): number {
  // Conservative UTF-8 byte budget, not a tokenizer-specific token guarantee.
  return Math.min(64_000, Math.max(4, tokens * 4));
}

function inputPreview(chars: string): string {
  // ASCII-only previews prevent bidi/format characters from disguising input.
  return JSON.stringify(chars).replace(/[\u007f-\uffff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export default function piProcesses(pi: ExtensionAPI): void {
  reportInstallTelemetry();
  let runtime: ProcessRuntime | undefined;
  let lifetime = new AbortController();
  const confirmations = new ConfirmationQueue();
  const onExit = () => runtime?.killAllSync();
  const current = () => {
    if (!runtime) throw new Error("pi-processes has no active session");
    return runtime;
  };
  const operationSignal = (signal?: AbortSignal) => signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;

  const approve = async (ctx: ExtensionToolContext, id: string, chars: string, signal: AbortSignal) => {
    if (signal.aborted) throw new Error("Input approval cancelled");
    if (!ctx.hasUI) throw new Error("Non-empty stdin requires interactive or RPC input approval");
    // Enforce a lifetime even when a custom RPC UI ignores its dialog options.
    const approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const approved = await confirmations.confirm(approvalSignal, () => ctx.ui.confirm(
        "Send input to process?",
        `Session: ${id}\nInput (escaped): ${inputPreview(chars)}\n\nInput may execute commands. DCG cannot validate partial terminal input.`,
        { signal: approvalSignal, timeout: 60_000 },
    ));
    if (!approved || signal.aborted) throw new Error("Process input was not approved");
  };

  pi.on("session_start", () => {
    lifetime = new AbortController();
    runtime = new ProcessRuntime((data, wake) => {
      // Only metadata, never command text or untrusted process output, enters a notification.
      const { output: _output, dropped_bytes: _dropped, unread_bytes: _unread, ...metadata } = data;
      pi.sendMessage({
        customType: "pi-processes-completed", content: JSON.stringify(metadata),
        display: true, details: metadata,
      }, { triggerTurn: wake, deliverAs: wake ? "followUp" : "nextTurn" });
    });
    process.on("exit", onExit);
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    const old = runtime;
    runtime = undefined;
    process.removeListener("exit", onExit);
    await old?.close();
  });

  pi.registerTool({
    name: "exec_command", label: "Execute process",
    description: "Run a local shell command with pipes or a PTY. Return output and a session_id for polling. macOS/Linux only; not a sandbox.",
    promptSnippet: "Run commands and retain background process sessions.",
    promptGuidelines: [
      "Use exec_command for commands that may outlive one tool call. Run independent commands concurrently.",
      "Poll a running session with write_stdin and empty chars. Use process_kill for termination.",
      "Use tty:true only for terminal-dependent commands. Every non-empty input write requires user approval.",
      "Output is bounded; dropped_bytes reports overflow and unread_bytes reports output available in further polls.",
      "notify_on_exit:true requests one follow-up model turn on background completion; leave false to avoid an automatic turn.",
    ],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    executionMode: "parallel",
    parameters: Type.Object({
      cmd: Type.String({ minLength: 1, maxLength: 65_536 }),
      workdir: Type.Optional(Type.String({ maxLength: 4096 })),
      tty: Type.Optional(Type.Boolean()),
      yield_time_ms: Yield,
      max_output_tokens: Budget,
      timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 86_400_000 })),
      notify_on_exit: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    outputSchema: ResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      // Snapshot before any await; hook-approved arguments cannot change during execution.
      const { cmd, workdir, tty = false, yield_time_ms = 10_000, max_output_tokens,
        timeout_ms = 1_800_000, notify_on_exit = false } = args;
      const rt = current();
      const op = operationSignal(signal);
      const cwd = await resolveWorkdir(workdir, ctx.cwd);
      return result(await rt.start(cmd, cwd, tty, timeout_ms, notify_on_exit,
        Math.min(30_000, yield_time_ms), maxBytes(max_output_tokens), op));
    },
  });

  pi.registerTool({
    name: "write_stdin", label: "Poll / input process",
    description: "Poll output with empty chars, or send approved input to a PTY process. Empty polls never require input approval. Cancelling a poll does not stop the process.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    executionMode: "parallel",
    parameters: Type.Object({
      session_id: SessionId, chars: Type.Optional(Type.String({ maxLength: 4096 })),
      yield_time_ms: Yield, max_output_tokens: Budget,
    }, { additionalProperties: false }),
    outputSchema: ResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      const { session_id, chars = "", yield_time_ms, max_output_tokens } = args;
      const rt = current();
      const op = operationSignal(signal);
      return rt.interact(session_id, async () => {
        if (chars) {
          if (!rt.isTty(session_id)) throw new Error("Input requires tty:true");
          await approve(ctx, session_id, chars, op);
          rt.write(session_id, chars, op);
        }
        return result(await rt.poll(session_id,
          Math.min(chars ? 30_000 : 300_000, yield_time_ms ?? (chars ? 250 : 1000)),
          maxBytes(max_output_tokens), op));
      }, op);
    },
  });

  pi.registerTool({
    name: "process_kill", label: "Stop process",
    description: "Stop a session-owned process group with SIGTERM, then SIGKILL. Does not stop processes owned by other sessions.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    executionMode: "parallel",
    parameters: Type.Object({ session_id: SessionId }, { additionalProperties: false }),
    outputSchema: ResultSchema,
    async execute(_id, { session_id }) {
      const rt = current();
      await rt.kill(session_id);
      // Stopping is a control operation: never wait behind an unresolved input
      // dialog. The final buffer read is synchronous once the job has exited.
      return result(await rt.poll(session_id, 0, 16_000));
    },
  });

  pi.registerTool({
    name: "process_list", label: "List processes",
    description: "List retained process sessions and exit status without consuming output.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    executionMode: "parallel",
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ processes: Type.Array(Type.Omit(ResultSchema, ["output", "dropped_bytes", "unread_bytes"])) }),
    async execute() {
      const data = { processes: current().list() };
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: data };
    },
  });
}
