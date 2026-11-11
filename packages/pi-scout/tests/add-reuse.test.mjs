import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sandbox = await mkdtemp(join(tmpdir(), "pi-scout-reuse-"));
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
process.env.PI_SCOUT_TMPDIR = join(sandbox, "clones");
process.env.PI_OFFLINE = "1";
// Hermetic Git: no user/system config, no network sources.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(sandbox, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Scout Test", GIT_AUTHOR_EMAIL: "scout@example.invalid",
  GIT_COMMITTER_NAME: "Scout Test", GIT_COMMITTER_EMAIL: "scout@example.invalid",
});
delete process.env.GIT_SSH_COMMAND;
delete process.env.GIT_SSH;
await writeFile(process.env.GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");

const { default: scout } = await import("../extensions/index.ts");
const { getScoutCloneRoot } = await import("../src/repo.ts");
const { getScoutStatePath, loadState, saveState } = await import("../src/state.ts");

function git(args, cwd = sandbox) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, killed: Boolean(error?.killed) });
    });
  });
}

async function mustGit(args, cwd) {
  const result = await git(args, cwd);
  assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Load the extension against a minimal Pi host whose exec runs real Git. */
function loadScout(execImpl) {
  const tools = new Map();
  const calls = [];
  const options = [];
  let active = [];
  scout({
    on() {}, registerCommand() {}, registerFlag() {}, getFlag: () => undefined,
    registerTool: tool => { tools.set(tool.name, tool); },
    getActiveTools: () => active, setActiveTools: names => { active = names; },
    exec: async (command, args, execOptions) => {
      assert.equal(command, "git");
      calls.push(args);
      options.push(execOptions);
      return execImpl ? execImpl(command, args, execOptions) : git(args, execOptions?.cwd ?? sandbox);
    },
  });
  const add = (params, cwd = sandbox) => tools.get("scout_add").execute("call", params, undefined, undefined, { cwd });
  return { tools, calls, options, add };
}

async function makeOrigin(name) {
  const bare = join(sandbox, `${name}.git`);
  const work = join(sandbox, `${name}-work`);
  await mustGit(["init", "--quiet", "--bare", bare]);
  await mustGit(["init", "--quiet", work]);
  await writeFile(join(work, "README.md"), "one\n");
  await mustGit(["add", "README.md"], work);
  await mustGit(["commit", "--quiet", "-m", "one"], work);
  await mustGit(["tag", "v1"], work);
  await mustGit(["switch", "--quiet", "-c", "feature"], work);
  await writeFile(join(work, "FEATURE.md"), "feature\n");
  await mustGit(["add", "FEATURE.md"], work);
  await mustGit(["commit", "--quiet", "-m", "feature"], work);
  await mustGit(["switch", "--quiet", "main"], work);
  await mustGit(["remote", "add", "origin", bare], work);
  await mustGit(["push", "--quiet", "origin", "main", "feature", "v1"], work);
  return { bare, work };
}

const SAFE = ["-c", "protocol.ext.allow=never", "-c", "credential.interactive=false"];
const BATCH_SSH = ["-c", "core.sshCommand=ssh -oBatchMode=yes"];
const EXEC_LIMITS = { timeout: 120_000, maxBuffer: 1024 * 1024 };

function stubGit({ sshCommand = "", clone = { code: 0 } } = {}) {
  return async (_command, args) => {
    if (args.includes("config")) return sshCommand ? { code: 0, stdout: `${sshCommand}\n`, stderr: "", killed: false } : { code: 1, stdout: "", stderr: "", killed: false };
    if (args.includes("clone") && clone.code === 0) await mkdir(args.at(-1), { recursive: true });
    return { stdout: "", stderr: "", killed: false, ...(args.includes("clone") ? clone : { code: 0 }) };
  };
}

async function cloneDirs() {
  return (await readdir(getScoutCloneRoot())).sort();
}

test.after(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("scout_add schema exposes source, branch and refresh only", () => {
  const { tools } = loadScout();
  const schema = tools.get("scout_add").parameters;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["branch", "refresh", "source"]);
  assert.deepEqual(schema.required, ["source"]);
  assert.equal(schema.additionalProperties, false);
  assert.ok(tools.get("scout_add").description.length < 80, "description stays short");
});

test("equivalent local spellings reuse one clone", async () => {
  const { bare } = await makeOrigin("reuse");
  const { add } = loadScout();
  const first = await add({ source: bare });
  assert.equal(first.structuredContent.status, "cloned");
  assert.equal(await readFile(join(first.structuredContent.repo.path, "README.md"), "utf8"), "one\n");
  const before = await cloneDirs();

  for (const source of [`${bare}/`, "reuse.git", "./reuse.git/", pathToFileURL(bare).href]) {
    const again = await add({ source });
    assert.equal(again.structuredContent.status, "reused", source);
    assert.equal(again.structuredContent.repo.id, first.structuredContent.repo.id, source);
    assert.match(again.content[0].text, /^Reused existing/);
  }
  assert.deepEqual(await cloneDirs(), before, "no second clone");
  assert.equal((await loadState()).repos.filter(repo => repo.path === first.structuredContent.repo.path).length, 1);
});

test("branch selects a separate clone and tags are supported", async () => {
  const { bare } = await makeOrigin("branches");
  const { add } = loadScout();
  const main = await add({ source: bare });
  const feature = await add({ source: bare, branch: "feature" });
  assert.equal(feature.structuredContent.status, "cloned");
  assert.notEqual(feature.structuredContent.repo.id, main.structuredContent.repo.id);
  assert.equal(feature.structuredContent.repo.branch, "feature");
  assert.equal(await readFile(join(feature.structuredContent.repo.path, "FEATURE.md"), "utf8"), "feature\n");
  assert.equal((await add({ source: `${bare}/`, branch: "feature" })).structuredContent.repo.id, feature.structuredContent.repo.id);

  const tag = await add({ source: pathToFileURL(bare).href, branch: "v1" });
  assert.equal(tag.structuredContent.status, "cloned");
  assert.equal(await mustGit(["rev-parse", "--is-shallow-repository"], tag.structuredContent.repo.path), "true");
});

test("branch values that could be read as options or invalid refs are rejected before Git runs", async () => {
  const { add, calls } = loadScout();
  for (const branch of ["-b", "--upload-pack=touch pwned", "a..b", "a b", "x:y", "refs/heads/x.lock", "@{u}"]) {
    await assert.rejects(add({ source: "owner/repo", branch }), { message: "Invalid branch or tag name." }, branch);
  }
  assert.equal(calls.length, 0);
});

test("refresh fetches and fast-forwards an existing clone", async () => {
  const { bare, work } = await makeOrigin("refresh");
  const { add, calls } = loadScout();
  const first = await add({ source: pathToFileURL(bare).href });
  const path = first.structuredContent.repo.path;
  assert.equal(await mustGit(["rev-parse", "--is-shallow-repository"], path), "true");

  await writeFile(join(work, "README.md"), "two\n");
  await mustGit(["commit", "--quiet", "-am", "two"], work);
  await mustGit(["push", "--quiet", "origin", "main"], work);

  assert.equal((await add({ source: bare })).structuredContent.status, "reused");
  assert.equal(await readFile(join(path, "README.md"), "utf8"), "one\n", "plain reuse does not touch the network");

  const refreshed = await add({ source: bare, refresh: true });
  assert.equal(refreshed.structuredContent.status, "refreshed");
  assert.equal(refreshed.structuredContent.repo.id, first.structuredContent.repo.id);
  assert.equal(await readFile(join(path, "README.md"), "utf8"), "two\n");
  const fetch = calls.find(args => args.includes("fetch"));
  assert.deepEqual(fetch, [...SAFE, ...BATCH_SSH, "-C", path, "fetch", "--quiet", "--no-progress", "--no-tags", "origin"]);
  assert.ok(calls.some(args => args.join(" ") === `-C ${path} config --get core.sshCommand`), "refresh reads the clone's SSH command");

  const fresh = await add({ source: join(sandbox, "refresh-work"), refresh: true });
  assert.equal(fresh.structuredContent.status, "cloned", "refresh of an unregistered source clones it");
});

test("refresh fails cleanly when the origin is unreachable and keeps the clone", async () => {
  const { bare } = await makeOrigin("offline");
  const { add } = loadScout();
  const { repo } = (await add({ source: bare })).structuredContent;
  await rename(bare, `${bare}-moved`);
  await assert.rejects(add({ source: bare, refresh: true }), (error) => {
    assert.equal(error.message, "Git fetch failed (exit code 128). Check the network and Git authentication; the existing clone is unchanged.");
    return true;
  });
  assert.equal(await readFile(join(repo.path, "README.md"), "utf8"), "one\n");
  assert.ok((await loadState()).repos.some(record => record.id === repo.id));
});

test("refresh refuses a recorded clone outside the private clone root", async () => {
  const outside = join(sandbox, "outside");
  await mkdir(outside);
  const state = await loadState();
  const now = new Date().toISOString();
  state.repos.push({ id: "outside", name: "outside", source: "https://fixture.invalid/outside.git", path: outside, createdAt: now, lastSeenAt: now });
  await saveState(state);
  const { add, calls } = loadScout();
  await assert.rejects(add({ source: "https://fixture.invalid/outside", refresh: true }), /outside the current private Scout directory/);
  assert.equal(calls.length, 0);
});

test("remote URL spellings, shorthand and credentials share one clone without persisting secrets", async () => {
  const { add, calls } = loadScout(async (_command, args) => {
    const destination = args.at(-1);
    if (args.includes("clone")) await mkdir(destination, { recursive: true });
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
  const first = await add({ source: "Scout-Owner/Scout-Repo" });
  assert.equal(first.structuredContent.status, "cloned");
  for (const source of [
    "https://github.com/scout-owner/scout-repo",
    "HTTPS://GitHub.com/Scout-Owner/Scout-Repo.git/",
    "https://synthetic-token@github.com/scout-owner/scout-repo.git",
    "scout-owner/scout-repo.git",
  ]) {
    const again = await add({ source });
    assert.equal(again.structuredContent.status, "reused", source);
    assert.equal(again.structuredContent.repo.id, first.structuredContent.repo.id, source);
  }
  assert.equal(calls.filter(args => args.includes("clone")).length, 1);

  const ssh = await add({ source: "git@github.com:scout-owner/scout-repo.git" });
  assert.equal(ssh.structuredContent.status, "cloned", "a different transport is a different clone");
  assert.equal((await add({ source: "git@GitHub.com:scout-owner/scout-repo/" })).structuredContent.repo.id, ssh.structuredContent.repo.id);

  const secret = await add({ source: "https://synthetic-user:synthetic-pass@fixture.invalid/team/app.git?token=synthetic-query" });
  assert.equal((await add({ source: "https://fixture.invalid/team/app" })).structuredContent.repo.id, secret.structuredContent.repo.id);
  assert.doesNotMatch(await readFile(getScoutStatePath(), "utf8"), /synthetic/);
  assert.doesNotMatch(JSON.stringify(secret), /synthetic/);
});

test("credentials persisted by earlier versions are redacted on load", async () => {
  const clone = join(getScoutCloneRoot(), "legacy");
  await mkdir(clone, { recursive: true });
  const state = await loadState();
  const now = new Date().toISOString();
  state.repos.push({ id: "legacy", name: "legacy", source: "https://synthetic-legacy:pw@fixture.invalid/legacy.git", path: clone, createdAt: now, lastSeenAt: now });
  await saveState(state);
  const { tools } = loadScout();
  const listed = await tools.get("scout_list").execute("call", {});
  assert.ok(listed.structuredContent.repos.some(repo => repo.id === "legacy"));
  const stored = await readFile(getScoutStatePath(), "utf8");
  assert.doesNotMatch(stored, /synthetic-legacy/);
  assert.match(stored, /https:\/\/fixture\.invalid\/legacy\.git/);
});

test("relative ./ and ../ paths are local paths, not GitHub shorthand", async () => {
  const { add, calls } = loadScout(async (_command, args) => {
    if (args.includes("clone")) await mkdir(args.at(-1), { recursive: true });
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
  const cwd = join(sandbox, "project");
  await add({ source: "./sibling" }, cwd);
  assert.equal(calls.at(-1).at(-2), join(cwd, "sibling"));
  await add({ source: "../other" }, cwd);
  assert.equal(calls.at(-1).at(-2), join(sandbox, "other"));
});

test("Git calls are non-interactive and output-bounded", async () => {
  const { add, calls, options } = loadScout(stubGit());
  const { repo } = (await add({ source: "https://fixture.invalid/team/batch.git", branch: "main" })).structuredContent;
  const root = getScoutCloneRoot();
  assert.deepEqual(calls, [
    ["config", "--get", "core.sshCommand"],
    [...SAFE, ...BATCH_SSH, "clone", "--quiet", "--no-progress", "--branch=main", "--depth", "1", "--", "https://fixture.invalid/team/batch.git", repo.path],
  ]);
  // Every call runs in the private clone root, never the project directory.
  assert.deepEqual(options.map(({ signal: _, ...rest }) => rest), [{ ...EXEC_LIMITS, cwd: root }, { ...EXEC_LIMITS, cwd: root }]);
});

test("a user-chosen SSH command is kept unchanged", async () => {
  const configured = loadScout(stubGit({ sshCommand: "my-ssh-wrapper" }));
  await configured.add({ source: "git@fixture.invalid:team/configured.git" });
  assert.deepEqual(configured.calls.at(-1).slice(0, 5), [...SAFE, "clone"]);

  process.env.GIT_SSH_COMMAND = "ssh -i synthetic-key";
  try {
    const env = loadScout(stubGit());
    await env.add({ source: "git@fixture.invalid:team/env.git" });
    assert.equal(env.calls.length, 1, "no config read when GIT_SSH_COMMAND decides");
    assert.deepEqual(env.calls[0].slice(0, 5), [...SAFE, "clone"]);
  } finally {
    delete process.env.GIT_SSH_COMMAND;
  }
});

test("truncated output is non-fatal; a stopped command fails without output", async () => {
  const ok = loadScout(stubGit({ clone: { code: 0, truncated: true } }));
  assert.equal((await ok.add({ source: "https://fixture.invalid/team/noisy.git" })).structuredContent.status, "cloned");

  const before = await cloneDirs();
  const stopped = loadScout(stubGit({ clone: { code: 1, truncated: true, killed: true, stderr: "synthetic-noise" } }));
  await assert.rejects(stopped.add({ source: "https://fixture.invalid/team/flood.git" }),
    { message: "Git clone stopped: output exceeded 1048576 bytes. Check the source and Git authentication." });
  assert.deepEqual(await cloneDirs(), before, "partial clone removed");
});
