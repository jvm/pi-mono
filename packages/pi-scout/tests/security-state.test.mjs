import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sandbox = await mkdtemp(join(tmpdir(), "pi-scout-test-"));
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
process.env.PI_SCOUT_TMPDIR = join(sandbox, "clones");

const {
  ensurePrivateCloneRoot,
  getScoutCloneRoot,
  registerRepo,
} = await import("../src/repo.ts");
const {
  getScoutStatePath,
  loadState,
  mutateState,
  saveState,
} = await import("../src/state.ts");

const unixOnly = process.platform === "win32" ? test.skip : test;

test.after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

unixOnly("clone root stays private under permissive umask", async () => {
  const previousUmask = process.umask(0o000);
  try {
    const root = getScoutCloneRoot();
    await ensurePrivateCloneRoot(root);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
  } finally {
    process.umask(previousUmask);
  }
});

unixOnly("unsafe clone-root symlink is rejected", async () => {
  const target = join(sandbox, "target");
  const root = join(sandbox, "unsafe-root");
  await mkdir(target);
  await symlink(target, root, "dir");
  await assert.rejects(ensurePrivateCloneRoot(root), /Unsafe Pi Scout clone root/);
});

test("concurrent state mutations preserve every repository", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, index) => mutateState((state) => {
    const timestamp = new Date().toISOString();
    state.repos.push({
      id: String(index),
      name: `repo-${index}`,
      source: `source-${index}`,
      path: sandbox,
      createdAt: timestamp,
      lastSeenAt: timestamp,
    });
  })));

  const state = await loadState();
  assert.equal(state.repos.length, 20);
  assert.deepEqual(state.repos.map((repo) => repo.id).sort(), Array.from({ length: 20 }, (_, index) => String(index)).sort());
});

test("failed save leaves previous valid state intact", async () => {
  const previous = await readFile(getScoutStatePath(), "utf8");
  await assert.rejects(saveState({ repos: [BigInt(1)] }));
  assert.equal(await readFile(getScoutStatePath(), "utf8"), previous);
});

unixOnly("existing clone root permissions are corrected", async () => {
  const root = getScoutCloneRoot();
  await chmod(root, 0o775);
  await ensurePrivateCloneRoot(root);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
});

unixOnly("registered clone directory is private", async () => {
  const pi = { exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const repo = await registerRepo(pi, { source: "owner/repo" });
  assert.equal((await lstat(repo.path)).mode & 0o777, 0o700);
});
