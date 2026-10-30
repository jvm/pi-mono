import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const version = "1.4.0";
const peers = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];
const json = async url => JSON.parse(await readFile(url, "utf8"));

test("all workspaces and installed Pi peers use the single current baseline", async () => {
  const lock = await json(new URL("package-lock.json", root));
  for (const entry of await readdir(new URL("packages/", root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await json(new URL(`packages/${entry.name}/package.json`, root));
    for (const peer of peers) {
      if (!manifest.devDependencies?.[peer]) continue;
      assert.equal(manifest.devDependencies[peer], version, `${entry.name}: ${peer}`);
      assert.equal(lock.packages[`packages/${entry.name}`].devDependencies[peer], version);
      assert.equal(manifest.peerDependencies[peer], "*", "Pi must remain host-supplied");
    }
  }
  for (const peer of peers) {
    const entry = fileURLToPath(import.meta.resolve(peer));
    const manifest = await json(join(dirname(entry), "..", "package.json"));
    assert.equal(manifest.version, version, `${peer} resolved from ${entry}`);
    assert.equal(lock.packages[`node_modules/${peer}`].version, version);
  }
});

test("isolated host runner rejects old and floating targets before installation", () => {
  for (const unsupported of ["1.1.0", "1.2.0", "latest"]) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("scripts/test-pi-compat.mjs", root)), unsupported,
    ], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected Pi 1\.4\.0/);
  }
});
