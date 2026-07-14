import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { handleInitCommand } = await import("../.test-dist/src/init.js");
const { FORCE_INIT_PROMPT, INIT_PROMPT } = await import("../.test-dist/src/prompt.js");

async function runInit(args, existing) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agentsmd-test-"));
  const messages = [];
  const notifications = [];

  if (existing) {
    await writeFile(join(cwd, "AGENTS.md"), "existing guide\n", "utf8");
  }

  try {
    await handleInitCommand(
      { sendUserMessage: (message) => messages.push(message) },
      args,
      {
        cwd,
        ui: {
          notify: (message, type) => notifications.push({ message, type }),
        },
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  return { messages, notifications };
}

test("/init sends normal prompt when AGENTS.md is missing", async () => {
  const result = await runInit("", false);

  assert.deepEqual(result.messages, [INIT_PROMPT]);
  assert.deepEqual(result.notifications, []);
});

test("/init warns without sending prompt when AGENTS.md exists", async () => {
  const result = await runInit("", true);

  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.notifications, [
    {
      message: "AGENTS.md already exists here. Use /init --force to overwrite.",
      type: "warning",
    },
  ]);
});

for (const args of ["--force", "-f"]) {
  test(`/init ${args} sends force prompt when AGENTS.md is missing`, async () => {
    const result = await runInit(args, false);

    assert.deepEqual(result.messages, [FORCE_INIT_PROMPT]);
    assert.deepEqual(result.notifications, []);
  });

  test(`/init ${args} sends force prompt when AGENTS.md exists`, async () => {
    const result = await runInit(args, true);

    assert.deepEqual(result.messages, [FORCE_INIT_PROMPT]);
    assert.deepEqual(result.notifications, []);
  });
}

test("force prompt explicitly authorizes replacement without no-overwrite instruction", () => {
  assert.match(FORCE_INIT_PROMPT, /explicitly invoked \/init with --force/);
  assert.match(FORCE_INIT_PROMPT, /Replace AGENTS\.md/);
  assert.doesNotMatch(FORCE_INIT_PROMPT, /do not overwrite or modify it/);
});
