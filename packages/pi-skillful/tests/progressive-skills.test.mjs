import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const home = await mkdtemp(join(tmpdir(), "pi-skillful-progressive-test-"));
process.env.HOME = home;

const { default: progressiveSkills } = await import(
  "../.test-dist/src/extensions/progressive-skills.js"
);

function registerProgressiveSkills() {
  const handlers = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
  };
  progressiveSkills(pi);
  return { handlers };
}

test("no git repo — returns nothing (Pi already walks to root)", async () => {
  const cwd = await mkdtemp(join(home, "no-git-"));
  const { handlers } = registerProgressiveSkills();

  const result = await handlers.get("resources_discover")({ cwd, reason: "startup" });
  assert.equal(result, undefined);
});

test("git repo with no ancestor .agents/skills/ — returns nothing", async () => {
  const repoRoot = await mkdtemp(join(home, "repo-no-ancestor-"));
  await mkdir(join(repoRoot, ".git"));
  const cwd = join(repoRoot, "sub");
  await mkdir(cwd);

  const { handlers } = registerProgressiveSkills();

  const result = await handlers.get("resources_discover")({ cwd, reason: "startup" });
  assert.equal(result, undefined);
});

test("git repo with .agents/skills/ in ancestor above repo root", async () => {
  const ancestor = await mkdtemp(join(home, "ancestor-"));
  const repoRoot = join(ancestor, "repo");
  await mkdir(repoRoot);
  await mkdir(join(repoRoot, ".git"));
  await mkdir(join(ancestor, ".agents", "skills"), { recursive: true });

  const cwd = join(repoRoot, "sub");
  await mkdir(cwd);

  const { handlers } = registerProgressiveSkills();

  const result = await handlers.get("resources_discover")({ cwd, reason: "startup" });
  assert.ok(result);
  assert.ok(result.skillPaths.length >= 1);
  assert.ok(
    result.skillPaths.some(
      (p) => resolve(p) === resolve(join(ancestor, ".agents", "skills")),
    ),
  );
});

test("~/.agents/skills/ is excluded from ancestor paths", async () => {
  const repoRoot = await mkdtemp(join(home, "repo-home-"));
  await mkdir(join(repoRoot, ".git"));
  const homeSkills = join(home, ".agents", "skills");
  await mkdir(homeSkills, { recursive: true });

  const cwd = join(repoRoot, "sub");
  await mkdir(cwd);

  const { handlers } = registerProgressiveSkills();

  const result = await handlers.get("resources_discover")({ cwd, reason: "startup" });

  // home is the parent of the temp dir, and ~/.agents/skills/ could be
  // in the ancestor chain. Verify it's excluded.
  if (result?.skillPaths) {
    for (const p of result.skillPaths) {
      assert.notEqual(resolve(p), resolve(homeSkills));
    }
  }
});

test("multiple ancestor .agents/skills/ dirs all discovered", async () => {
  const grandparent = await mkdtemp(join(home, "grandparent-"));
  const parent = join(grandparent, "parent");
  const repoRoot = join(parent, "repo");

  await mkdir(parent);
  await mkdir(repoRoot);
  await mkdir(join(repoRoot, ".git"));

  await mkdir(join(grandparent, ".agents", "skills"), { recursive: true });
  await mkdir(join(parent, ".agents", "skills"), { recursive: true });

  const cwd = repoRoot;
  const { handlers } = registerProgressiveSkills();

  const result = await handlers.get("resources_discover")({ cwd, reason: "startup" });
  assert.ok(result);
  assert.ok(result.skillPaths.length >= 1);
  assert.ok(
    result.skillPaths.some(
      (p) => resolve(p) === resolve(join(grandparent, ".agents", "skills")),
    ),
  );
  assert.ok(
    result.skillPaths.some(
      (p) => resolve(p) === resolve(join(parent, ".agents", "skills")),
    ),
  );
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
