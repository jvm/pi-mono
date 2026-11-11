import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { listWorkspacePackages, prepareHostWorkspace } from "../scripts/workspace-packages.mjs";

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

// A removed package whose untracked generated files survived the Git deletion.
async function addLeftoverPackage(packagesDir) {
  await mkdir(join(packagesDir, "pi-retired", "skills", "demo"), { recursive: true });
  await writeFile(join(packagesDir, "pi-retired", "skills", "demo", "SKILL.md"), "x");
  await writeFile(join(packagesDir, "pi-retired", "THIRD-PARTY-NOTICES"), "x");
}

test("the isolated host lane pins every workspace and skips a leftover package directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-host-lane-"));
  const source = join(dir, "source");
  const target = join(dir, "target");
  try {
    await mkdir(join(source, "packages", "pi-live"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", devDependencies: { "@earendil-works/pi-ai": "1.0.0" } }));
    await writeFile(join(source, "packages", "pi-live", "package.json"), JSON.stringify({
      devDependencies: { "@earendil-works/pi-coding-agent": "1.0.0", typescript: "5.0.0" },
    }));
    await mkdir(join(source, "node_modules", "dep"), { recursive: true });
    await addLeftoverPackage(join(source, "packages"));

    await prepareHostWorkspace(source, target, "9.9.9");

    const rootManifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.deepEqual(rootManifest.devDependencies, {
      "@earendil-works/pi-ai": "9.9.9", "@earendil-works/pi-coding-agent": "9.9.9", "@earendil-works/pi-tui": "9.9.9",
    });
    const manifest = JSON.parse(await readFile(join(target, "packages", "pi-live", "package.json"), "utf8"));
    assert.deepEqual(manifest.devDependencies, { "@earendil-works/pi-coding-agent": "9.9.9", typescript: "5.0.0" });
    assert.deepEqual(await readdir(join(target, "packages", "pi-retired")), ["THIRD-PARTY-NOTICES", "skills"]);
    await assert.rejects(stat(join(target, "node_modules")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("package validation passes with a leftover package directory in the workspace", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "pi-validate-"));
  try {
    for (const path of ["README.md", "scripts", "templates", "packages"]) {
      await cp(join(repo, path), join(dir, path), { recursive: true, filter: (from) => basename(from) !== "node_modules" });
    }
    await addLeftoverPackage(join(dir, "packages"));
    const result = spawnSync(process.execPath, [join(dir, "scripts", "validate-packages.mjs")], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const count = (await listWorkspacePackages(join(repo, "packages"))).length;
    assert.equal(result.stdout.trim(), `Validated ${count} packages.`);
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
