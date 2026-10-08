import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const profile = await mkdtemp(join(tmpdir(), "pi-scout-prompt-"));
process.env.PI_CODING_AGENT_DIR = join(profile, "agent");
process.env.PI_OFFLINE = "1";
const { default: scout } = await import("../extensions/index.ts");
const { saveState, loadState } = await import("../src/state.ts");

function promptHandler() {
  const handlers = new Map();
  let active = [];
  scout({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {},
    registerTool() {},
    getActiveTools: () => active,
    setActiveTools: names => { active = names; },
  });
  return handlers.get("before_agent_start");
}

test("Scout owns one named section without changing explicit prompt policy or exposing metadata", async () => {
  const clone = join(profile, "reference");
  await mkdir(clone);
  await saveState({ repos: [{
    id: "private-id", name: "reference", path: clone, source: "private-origin", branch: "private-branch",
    createdAt: "private-timestamp", lastSeenAt: "private-timestamp",
  }] });
  const handler = promptHandler();
  const event = {
    systemPrompt: "Explicit policy.",
    systemPromptOptions: { forceSystemPrompt: "Explicit policy.", sections: { unrelated: "Keep me." } },
  };
  assert.equal(await handler(event), undefined);
  const { sections } = event.systemPromptOptions;
  assert.deepEqual(Object.keys(sections).sort(), ["scout_repos", "unrelated"]);
  assert.match(sections.scout_repos, /Scout repos:/);
  assert.ok(sections.scout_repos.includes(`- reference: ${clone}`));
  assert.doesNotMatch(sections.scout_repos, /private-/);
  assert.equal(event.systemPrompt, "Explicit policy.");
  assert.equal(event.systemPromptOptions.forceSystemPrompt, "Explicit policy.");
  await handler(event);
  assert.equal((sections.scout_repos.match(/Scout repos:/g) ?? []).length, 1);

  await rm(clone, { recursive: true });
  await handler(event);
  assert.deepEqual((await loadState()).repos, []);
  assert.deepEqual(sections, { unrelated: "Keep me." }, "remove stale sections, not other extensions' content");
});

test.after(async () => { await rm(profile, { recursive: true, force: true }); });
