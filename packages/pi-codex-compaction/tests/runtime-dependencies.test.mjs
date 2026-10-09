import assert from "node:assert/strict";
import { mkdtemp, cp, mkdir, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const hostDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadExtensions } = await import(join(hostDist, "core/extensions/loader.js"));

// Outside the workspace, Pi supplies host peers; the extension must not
// install its own copy of host modules.
test("loads the published entry with host peers and declared runtime dependencies", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.dependencies[name], undefined);
  }
  const temp = await mkdtemp(join(tmpdir(), "compaction-load-"));
  try {
    for (const path of ["index.ts", "extensions", "src", "package.json"]) {
      await cp(join(root, path), join(temp, path), { recursive: true });
    }
    for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)]) {
      let target = dirname(fileURLToPath(import.meta.resolve(name)));
      while (true) {
        const candidate = await readFile(join(target, "package.json"), "utf8").catch(() => "{}");
        if (JSON.parse(candidate).name === name) break;
        const parent = dirname(target);
        assert.notEqual(parent, target, `Cannot locate ${name}`);
        target = parent;
      }
      const link = join(temp, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link, "dir");
    }
    const result = await loadExtensions([join(temp, "index.ts")], temp);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
