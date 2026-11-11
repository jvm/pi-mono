import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { listWorkspacePackages } from "../scripts/workspace-packages.mjs";

test("lists only directories with a package.json, like npm workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workspaces-"));
  try {
    await mkdir(join(dir, "pi-b"));
    await writeFile(join(dir, "pi-b", "package.json"), "{}");
    await mkdir(join(dir, "pi-a"));
    await writeFile(join(dir, "pi-a", "package.json"), "{}");
    // A removed package whose untracked generated files survived the Git deletion.
    await mkdir(join(dir, "pi-retired", "skills", "demo"), { recursive: true });
    await writeFile(join(dir, "pi-retired", "skills", "demo", "SKILL.md"), "x");
    await writeFile(join(dir, "pi-retired", "THIRD-PARTY-NOTICES"), "x");
    await mkdir(join(dir, "pi-odd", "package.json"), { recursive: true });
    await writeFile(join(dir, "README.md"), "x");

    assert.deepEqual(await listWorkspacePackages(dir), ["pi-a", "pi-b"]);
    assert.deepEqual(await listWorkspacePackages(pathToFileURL(`${dir}/`)), ["pi-a", "pi-b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lists the same packages as npm workspace resolution", async () => {
  const result = spawnSync("npm", ["query", ".workspace"], {
    cwd: new URL("../", import.meta.url), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const workspaces = JSON.parse(result.stdout).map((entry) => entry.location.replace(/^packages\//, "")).sort();
  assert.deepEqual(await listWorkspacePackages(new URL("../packages/", import.meta.url)), workspaces);
});
