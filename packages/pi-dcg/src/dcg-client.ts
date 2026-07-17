import { spawn } from "node:child_process";
import type { DcgBridgeConfig } from "./config.js";
import { parseDcgHookResponse, type DcgDecision } from "./protocol.js";

export const MINIMUM_RECOMMENDED_DCG_VERSION = "0.6.8";

export type DcgProcessErrorCode =
  | "aborted"
  | "output_limit"
  | "spawn_failed"
  | "timed_out";

export class DcgProcessError extends Error {
  constructor(
    message: string,
    public readonly code: DcgProcessErrorCode,
  ) {
    super(message);
    this.name = "DcgProcessError";
  }
}

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type ProcessExecutor = (request: ProcessRequest) => Promise<ProcessResult>;

export const executeProcess: ProcessExecutor = (request) => new Promise((resolve, reject) => {
  if (request.signal?.aborted) {
    reject(new DcgProcessError("dcg check was cancelled", "aborted"));
    return;
  }

  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let settled = false;
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;

  const cleanup = (): void => {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  };

  const rejectOnce = (error: Error, kill = false): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (kill && child.exitCode === null) child.kill();
    reject(error);
  };

  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (settled) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > request.maxOutputBytes) {
      rejectOnce(new DcgProcessError("dcg output exceeded the bridge limit", "output_limit"), true);
      return;
    }
    if (stream === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };

  const onAbort = (): void => {
    rejectOnce(new DcgProcessError("dcg check was cancelled", "aborted"), true);
  };

  const timeout = setTimeout(() => {
    rejectOnce(new DcgProcessError(`dcg did not finish within ${request.timeoutMs}ms`, "timed_out"), true);
  }, request.timeoutMs);

  request.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  child.once("error", (error) => {
    rejectOnce(new DcgProcessError(`could not start dcg: ${error.message}`, "spawn_failed"));
  });
  child.once("close", (exitCode) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve({ stdout, stderr, exitCode });
  });

  if (request.input !== undefined) {
    if (!child.stdin) {
      rejectOnce(new DcgProcessError("could not open dcg stdin", "spawn_failed"), true);
      return;
    }
    child.stdin.once("error", (error) => {
      rejectOnce(new DcgProcessError(`could not send the command to dcg: ${error.message}`, "spawn_failed"), true);
    });
    child.stdin.end(request.input, "utf8");
  }
});

export interface DcgProbeResult {
  version: string;
}

export interface DcgClientLike {
  check(command: string, cwd: string, signal?: AbortSignal): Promise<DcgDecision>;
  probe(cwd: string, signal?: AbortSignal): Promise<DcgProbeResult>;
}

function processEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    PI_CODING_AGENT: "true",
    DCG_NO_SELF_HEAL: "1",
    DCG_NO_COLOR: "1",
    NO_COLOR: "1",
  };
}

function parseVersion(stdout: string): string {
  const match = stdout.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  if (match?.[1]) return match[1];
  const firstLine = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) throw new Error("dcg --version returned no version");
  return firstLine.replace(/^dcg\s+/i, "");
}

function parseSemver(value: string): [number, number, number] | undefined {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isRecommendedDcgVersion(version: string): boolean {
  const actual = parseSemver(version);
  const minimum = parseSemver(MINIMUM_RECOMMENDED_DCG_VERSION);
  if (!actual || !minimum) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export class DcgClient implements DcgClientLike {
  constructor(
    public readonly config: DcgBridgeConfig,
    private readonly processExecutor: ProcessExecutor = executeProcess,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async check(command: string, cwd: string, signal?: AbortSignal): Promise<DcgDecision> {
    const input = `${JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      cwd,
    })}\n`;
    const result = await this.processExecutor({
      command: this.config.binary,
      args: [],
      cwd,
      env: processEnvironment(this.environment),
      input,
      timeoutMs: this.config.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
      signal,
    });

    if (result.exitCode !== 0) {
      const exit = result.exitCode === null ? "a signal" : `exit code ${result.exitCode}`;
      throw new Error(`dcg hook failed with ${exit}`);
    }
    return parseDcgHookResponse(result.stdout);
  }

  async probe(cwd: string, signal?: AbortSignal): Promise<DcgProbeResult> {
    const result = await this.processExecutor({
      command: this.config.binary,
      args: ["--version"],
      cwd,
      env: processEnvironment(this.environment),
      timeoutMs: Math.min(this.config.timeoutMs, 1_500),
      maxOutputBytes: this.config.maxOutputBytes,
      signal,
    });
    if (result.exitCode !== 0) {
      const exit = result.exitCode === null ? "a signal" : `exit code ${result.exitCode}`;
      throw new Error(`dcg --version failed with ${exit}`);
    }
    return { version: parseVersion(result.stdout) };
  }
}
