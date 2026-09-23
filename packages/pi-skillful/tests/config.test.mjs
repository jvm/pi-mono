import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const home = await mkdtemp(join(tmpdir(), "pi-skillful-config-test-"));
process.env.HOME = home;

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
      descriptionKey: "ctrl+o",
    },
  });
  await writeJson(join(cwd, ".pi", "settings.json"), {
    skillful: {
      hiddenSkills: ["project-hidden"],
      toggleSlots: { 2: "project-skill" },
      toggleModifier: "alt",
      descriptionKey: "f2",
    },
  });

  const settings = await readEffectiveSkillfulSettings(cwd, true);

  assert.deepEqual(settings.hiddenSkills, ["project-hidden"]);
  assert.deepEqual(settings.toggleSlots, { 2: "project-skill" });
  assert.equal(settings.toggleModifier, "alt");
  assert.equal(settings.descriptionKey, "f2");
  assert.equal(settings.descriptionKeyDefined, true);
  assert.equal(settings.toggleModifierDefined, true);
});

test("untrusted projects use only global skillful settings", async () => {
  const cwd = await mkdtemp(join(home, "untrusted-"));
  await writeJson(globalPath, {
    skillful: {
      hiddenSkills: ["global-hidden"],
      toggleSlots: { 1: "global-skill" },
      toggleModifier: "ctrl",
      descriptionKey: "ctrl+o",
    },
  });
  await writeJson(join(cwd, ".pi", "settings.json"), {
    skillful: {
      hiddenSkills: ["project-hidden"],
      toggleSlots: { 2: "project-skill" },
      toggleModifier: "alt",
      descriptionKey: "f2",
    },
  });

  const settings = await readEffectiveSkillfulSettings(cwd, false);

  assert.deepEqual(settings.hiddenSkills, ["global-hidden"]);
  assert.deepEqual(settings.toggleSlots, { 1: "global-skill" });
  assert.equal(settings.toggleModifier, "ctrl");
  assert.equal(settings.descriptionKey, "ctrl+o");
});

test("explicit default interaction keys override global values", async () => {
  const cwd = await mkdtemp(join(home, "modifier-"));
  const projectPath = join(cwd, ".pi", "settings.json");
  await writeJson(globalPath, { skillful: { toggleModifier: "ctrl", descriptionKey: "ctrl+o" } });
  await writeJson(projectPath, { skillful: { toggleModifier: "alt", descriptionKey: "space" } });

  let settings = await readEffectiveSkillfulSettings(cwd, true);
  assert.equal(settings.toggleModifier, "alt");
  assert.equal(settings.descriptionKey, "space");

  await writeJson(projectPath, { skillful: {} });
  settings = await readEffectiveSkillfulSettings(cwd, true);
  assert.equal(settings.toggleModifier, "ctrl");
  assert.equal(settings.descriptionKey, "ctrl+o");

  await writeJson(projectPath, { skillful: { toggleModifier: "unsupported", descriptionKey: "ctrl+bogus" } });
  settings = await readEffectiveSkillfulSettings(cwd, true);
  assert.equal(settings.toggleModifier, "alt");
  assert.equal(settings.descriptionKey, "space");
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

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
