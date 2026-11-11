import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { listWorkspacePackages } from "../scripts/workspace-packages.mjs";

const root = new URL("../", import.meta.url);
const version = "1.5.2";
const peers = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];
const json = async url => JSON.parse(await readFile(url, "utf8"));

/** Asserts every workspace package under `workspaceRoot` pins Pi at the baseline; returns the names checked. */
async function assertWorkspaceBaseline(workspaceRoot) {
  const lock = await json(new URL("package-lock.json", workspaceRoot));
  const names = await listWorkspacePackages(new URL("packages/", workspaceRoot));
  for (const name of names) {
    const manifest = await json(new URL(`packages/${name}/package.json`, workspaceRoot));
    for (const peer of peers) {
      if (!manifest.devDependencies?.[peer]) continue;
      assert.equal(manifest.devDependencies[peer], version, `${name}: ${peer}`);
      assert.equal(lock.packages[`packages/${name}`].devDependencies[peer], version);
      assert.equal(manifest.peerDependencies[peer], "*", "Pi must remain host-supplied");
    }
  }
  return names;
}

test("all workspaces and installed Pi peers use the single current baseline", async () => {
  const lock = await json(new URL("package-lock.json", root));
  await assertWorkspaceBaseline(root);
  for (const peer of peers) {
    const entry = fileURLToPath(import.meta.resolve(peer));
    const manifest = await json(join(dirname(entry), "..", "package.json"));
    assert.equal(manifest.version, version, `${peer} resolved from ${entry}`);
    assert.equal(lock.packages[`node_modules/${peer}`].version, version);
  }
});

test("the baseline check skips a leftover package directory without package.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-baseline-"));
  try {
    const devDependencies = Object.fromEntries(peers.map(peer => [peer, version]));
    await mkdir(join(dir, "packages", "pi-live"), { recursive: true });
    await writeFile(join(dir, "packages", "pi-live", "package.json"), JSON.stringify({
      devDependencies, peerDependencies: Object.fromEntries(peers.map(peer => [peer, "*"])),
    }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ packages: { "packages/pi-live": { devDependencies } } }));
    // A removed package whose untracked generated files survived the Git deletion.
    await mkdir(join(dir, "packages", "pi-retired", "skills"), { recursive: true });
    await writeFile(join(dir, "packages", "pi-retired", "skills", "SKILL.md"), "x");
    assert.deepEqual(await assertWorkspaceBaseline(pathToFileURL(`${dir}/`)), ["pi-live"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isolated host runner rejects old and floating targets before installation", () => {
  for (const unsupported of ["1.1.0", "1.4.0", "latest"]) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("scripts/test-pi-compat.mjs", root)), unsupported,
    ], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected Pi 1\.5\.2/);
  }
});
