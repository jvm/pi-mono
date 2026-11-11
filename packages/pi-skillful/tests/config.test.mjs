import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const home = await mkdtemp(join(tmpdir(), "pi-skillful-config-test-"));
process.env.HOME = home;
// Resolve the default agent directory under the temporary HOME.
delete process.env.PI_CODING_AGENT_DIR;

const {
  readEffectiveSkillfulSettings,
  writeHiddenSkills,
  writeProjectSkillfulOverride,
} = await import("../.test-dist/src/config.js");

const globalPath = join(home, ".pi", "agent", "settings.json");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

test("trusted projects override global skillful settings", async () => {
  const cwd = await mkdtemp(join(home, "trusted-"));
  await writeJson(globalPath, {
    skillful: {
      hiddenSkills: ["global-hidden"],
      toggleSlots: { 1: "global-skill" },
      toggleModifier: "ctrl",
    },
  });
  await writeJson(join(cwd, ".pi", "settings.json"), {
    skillful: {
      hiddenSkills: ["project-hidden"],
      toggleSlots: { 2: "project-skill" },
      toggleModifier: "alt",
    },
  });

  const settings = await readEffectiveSkillfulSettings(cwd, true);

  assert.deepEqual(settings.hiddenSkills, ["project-hidden"]);
  assert.deepEqual(settings.toggleSlots, { 2: "project-skill" });
  assert.equal(settings.toggleModifier, "alt");
  assert.equal(settings.toggleModifierDefined, true);
});

test("untrusted projects use only global skillful settings", async () => {
  const cwd = await mkdtemp(join(home, "untrusted-"));
  await writeJson(globalPath, {
    skillful: {
      hiddenSkills: ["global-hidden"],
      toggleSlots: { 1: "global-skill" },
      toggleModifier: "ctrl",
    },
  });
  await writeJson(join(cwd, ".pi", "settings.json"), {
    skillful: {
      hiddenSkills: ["project-hidden"],
      toggleSlots: { 2: "project-skill" },
      toggleModifier: "alt",
    },
  });

  const settings = await readEffectiveSkillfulSettings(cwd, false);

  assert.deepEqual(settings.hiddenSkills, ["global-hidden"]);
  assert.deepEqual(settings.toggleSlots, { 1: "global-skill" });
  assert.equal(settings.toggleModifier, "ctrl");
});

test("explicit default modifier overrides global modifier", async () => {
  const cwd = await mkdtemp(join(home, "modifier-"));
  const projectPath = join(cwd, ".pi", "settings.json");
  await writeJson(globalPath, { skillful: { toggleModifier: "ctrl" } });
  await writeJson(projectPath, { skillful: { toggleModifier: "alt" } });

  let settings = await readEffectiveSkillfulSettings(cwd, true);
  assert.equal(settings.toggleModifier, "alt");

  await writeJson(projectPath, { skillful: {} });
  settings = await readEffectiveSkillfulSettings(cwd, true);
  assert.equal(settings.toggleModifier, "ctrl");

  await writeJson(projectPath, { skillful: { toggleModifier: "unsupported" } });
  settings = await readEffectiveSkillfulSettings(cwd, true);
  assert.equal(settings.toggleModifier, "alt");
});

test("project writes require active trust", async () => {
  const cwd = await mkdtemp(join(home, "write-guard-"));
  const projectPath = join(cwd, ".pi", "settings.json");
  const original = { skillful: { hiddenSkills: ["unchanged"] } };
  await writeJson(projectPath, original);

  await assert.rejects(
    writeHiddenSkills("project", cwd, ["changed"]),
    /Project skillful settings require a trusted project/,
  );
  await assert.rejects(
    writeProjectSkillfulOverride(cwd, ["changed"], {}, false),
    /Project skillful settings require a trusted project/,
  );

  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf-8")), original);
});

test("global settings follow PI_CODING_AGENT_DIR for reads and writes", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-skillful-agent-dir-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(agentDir, { recursive: true, force: true });
  });
  const cwd = await mkdtemp(join(home, "agent-dir-"));
  await writeJson(globalPath, { skillful: { hiddenSkills: ["home-default"] } });
  await writeJson(join(agentDir, "settings.json"), { skillful: { hiddenSkills: ["custom-dir"] } });

  let settings = await readEffectiveSkillfulSettings(cwd, false);
  assert.deepEqual(settings.hiddenSkills, ["custom-dir"]);

  await writeHiddenSkills("global", cwd, ["written"]);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf-8")).skillful.hiddenSkills, ["written"]);
  assert.deepEqual(JSON.parse(await readFile(globalPath, "utf-8")).skillful.hiddenSkills, ["home-default"]);
  settings = await readEffectiveSkillfulSettings(cwd, false);
  assert.deepEqual(settings.hiddenSkills, ["written"]);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
