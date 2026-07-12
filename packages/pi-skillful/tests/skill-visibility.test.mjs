import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const home = await mkdtemp(join(tmpdir(), "pi-skillful-test-"));
process.env.HOME = home;

const { default: skillVisibility } = await import("../.test-dist/src/extensions/skill-visibility.js");

test("session start preserves global hidden skills when no skills are loaded", async () => {
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(
    settingsPath,
    `${JSON.stringify({ skillful: { hiddenSkills: ["user-skill"] } }, null, 2)}\n`,
    "utf-8",
  );

  const handlers = new Map();
  skillVisibility({
    getCommands: () => [],
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => undefined,
  });

  await handlers.get("session_start")({}, { cwd: home, ui: { theme: {} } });

  const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
  assert.deepEqual(settings.skillful.hiddenSkills, ["user-skill"]);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
