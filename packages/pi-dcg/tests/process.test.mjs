import assert from "node:assert/strict";
import test from "node:test";

import { DcgProcessError, executeProcess } from "../src/dcg-client.ts";

const cwd = process.cwd();
const baseRequest = {
  command: process.execPath,
  cwd,
  env: { ...process.env, PI_DCG_PROCESS_TEST: "present" },
  timeoutMs: 2_000,
  maxOutputBytes: 32 * 1024,
};

test("executes directly with stdin, cwd, and environment", async () => {
  const script = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ input, cwd: process.cwd(), marker: process.env.PI_DCG_PROCESS_TEST })));",
  ].join("");
  const result = await executeProcess({
    ...baseRequest,
    args: ["-e", script],
    input: "payload",
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { input: "payload", cwd, marker: "present" });
});

test("enforces the process timeout", async () => {
  await assert.rejects(
    executeProcess({
      ...baseRequest,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 30,
    }),
    (error) => error instanceof DcgProcessError && error.code === "timed_out",
  );
});

test("enforces the combined output limit", async () => {
  await assert.rejects(
    executeProcess({
      ...baseRequest,
      args: ["-e", "process.stdout.write('x'.repeat(10000))"],
      maxOutputBytes: 100,
    }),
    (error) => error instanceof DcgProcessError && error.code === "output_limit",
  );
});

test("cancels an active process", async () => {
  const controller = new AbortController();
  const promise = executeProcess({
    ...baseRequest,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    promise,
    (error) => error instanceof DcgProcessError && error.code === "aborted",
  );
});

test("reports spawn failures without invoking a shell", async () => {
  await assert.rejects(
    executeProcess({
      ...baseRequest,
      command: `missing-dcg-${process.pid}`,
      args: [],
    }),
    (error) => error instanceof DcgProcessError && error.code === "spawn_failed",
  );
});
