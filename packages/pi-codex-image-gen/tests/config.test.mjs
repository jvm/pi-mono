import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadConfig, resolveUnderCwd } from "../.test-dist/extensions/index.js";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

test("project config is merged only for trusted projects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-image-gen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await writeJson(join(agentDir, "extensions", "codex-image-gen.json"), {
    save: "global",
    saveDir: "/global/output",
    model: "global-model",
  });
  await writeJson(join(cwd, ".pi", "extensions", "codex-image-gen.json"), {
    save: "custom",
    saveDir: "/project/output",
    model: "project-model",
  });

  assert.deepEqual(loadConfig(cwd, true, agentDir), {
    save: "custom",
    saveDir: "/project/output",
    model: "project-model",
  });
  assert.deepEqual(loadConfig(cwd, false, agentDir), {
    save: "global",
    saveDir: "/global/output",
    model: "global-model",
  });
});

test("inactive non-interactive trust ignores project config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-image-gen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(join(root, "project", ".pi", "extensions", "codex-image-gen.json"), { save: "custom" });

  assert.deepEqual(loadConfig(join(root, "project"), false, join(root, "missing-agent")), {});
});

test("custom paths expand home and preserve relative and absolute paths", () => {
  assert.equal(resolveUnderCwd("/workspace", "~", "/home/tester"), "/home/tester");
  assert.equal(resolveUnderCwd("/workspace", "~/Pictures/generated", "/home/tester"), "/home/tester/Pictures/generated");
  assert.equal(resolveUnderCwd("/workspace", "output/images", "/home/tester"), "/workspace/output/images");
  assert.equal(resolveUnderCwd("/workspace", "/var/images", "/home/tester"), "/var/images");
  assert.equal(resolveUnderCwd("/workspace", "~other/images", "/home/tester"), "/workspace/~other/images");
});
