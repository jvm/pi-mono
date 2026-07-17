import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";

const home = await mkdtemp(join(tmpdir(), "pi-skillful-visibility-test-"));
process.env.HOME = home;
initTheme("dark");

const {
  default: skillVisibility,
  installStartupSkillListPatch,
} = await import("../.test-dist/src/extensions/skill-visibility.js");

const globalSettingsPath = join(home, ".pi", "agent", "settings.json");
const identityTheme = {
  bg: (_color, text) => text,
  bold: (text) => text,
  fg: (_color, text) => text,
};

function skill(name, scope = "user") {
  const path = join(home, `${name}.md`);
  return {
    name,
    description: `${name} description`,
    filePath: path,
    baseDir: home,
    sourceInfo: { path, source: "auto", scope, origin: "top-level", baseDir: home },
  };
}

function commandForSkill(value) {
  return {
    name: `skill:${value.name}`,
    description: value.description,
    source: "skill",
    sourceInfo: value.sourceInfo,
  };
}

function registerVisibility(commands = []) {
  const handlers = new Map();
  const registeredCommands = new Map();
  const pi = {
    getCommands: () => commands,
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, options) => registeredCommands.set(name, options),
  };
  skillVisibility(pi);
  return { handlers, registeredCommands };
}

async function writeSettings(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

test("session start preserves configured global hidden skills", async () => {
  await writeSettings(globalSettingsPath, { skillful: { hiddenSkills: ["user-skill"] } });
  const { handlers } = registerVisibility();

  await handlers.get("session_start")(
    { reason: "startup" },
    { cwd: home, isProjectTrusted: () => false, ui: { theme: identityTheme } },
  );

  const settings = JSON.parse(await readFile(globalSettingsPath, "utf-8"));
  assert.deepEqual(settings.skillful.hiddenSkills, ["user-skill"]);
});

for (const mode of ["tui", "print"]) {
  test(`untrusted project visibility settings are ignored in ${mode} mode`, async () => {
    const cwd = await mkdtemp(join(home, `${mode}-untrusted-`));
    const globalSkill = skill(`global-${mode}`);
    const projectSkill = skill(`project-${mode}`, "project");
    const skills = [globalSkill, projectSkill];
    await writeSettings(globalSettingsPath, { skillful: { hiddenSkills: [globalSkill.name] } });
    await writeSettings(join(cwd, ".pi", "settings.json"), {
      skillful: { hiddenSkills: [projectSkill.name] },
    });
    const { handlers } = registerVisibility(skills.map(commandForSkill));
    const ctx = {
      cwd,
      hasUI: mode === "tui",
      isProjectTrusted: () => false,
      mode,
      ui: { theme: identityTheme },
    };

    await handlers.get("session_start")({ reason: "startup" }, ctx);
    const result = await handlers.get("before_agent_start")(
      { systemPrompt: `base${formatSkillsForPrompt(skills)}`, systemPromptOptions: { skills } },
      ctx,
    );

    assert.ok(result.systemPrompt.includes(`<name>${projectSkill.name}</name>`));
    assert.ok(!result.systemPrompt.includes(`<name>${globalSkill.name}</name>`));
  });
}

test("trusted project visibility settings override global settings", async () => {
  const cwd = await mkdtemp(join(home, "trusted-"));
  const globalSkill = skill("global-trusted");
  const projectSkill = skill("project-trusted", "project");
  const skills = [globalSkill, projectSkill];
  await writeSettings(globalSettingsPath, { skillful: { hiddenSkills: [globalSkill.name] } });
  await writeSettings(join(cwd, ".pi", "settings.json"), {
    skillful: { hiddenSkills: [projectSkill.name] },
  });
  const { handlers } = registerVisibility(skills.map(commandForSkill));
  const ctx = { cwd, isProjectTrusted: () => true, ui: { theme: identityTheme } };

  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const result = await handlers.get("before_agent_start")(
    { systemPrompt: `base${formatSkillsForPrompt(skills)}`, systemPromptOptions: { skills } },
    ctx,
  );

  assert.ok(result.systemPrompt.includes(`<name>${globalSkill.name}</name>`));
  assert.ok(!result.systemPrompt.includes(`<name>${projectSkill.name}</name>`));
});

test("untrusted projects expose only global settings in the menu", async () => {
  const cwd = await mkdtemp(join(home, "menu-untrusted-"));
  const loadedSkill = skill("menu-skill");
  const projectPath = join(cwd, ".pi", "settings.json");
  const projectSettings = { skillful: { hiddenSkills: [loadedSkill.name] } };
  await writeSettings(globalSettingsPath, { skillful: {} });
  await writeSettings(projectPath, projectSettings);
  const { registeredCommands } = registerVisibility([commandForSkill(loadedSkill)]);
  let menu;
  const tui = { requestRender: () => undefined };
  const ctx = {
    cwd,
    isProjectTrusted: () => false,
    mode: "tui",
    ui: {
      custom: async (factory) => {
        menu = factory(tui, identityTheme, {}, () => undefined);
      },
      notify: () => undefined,
    },
  };

  await registeredCommands.get("skillful").handler("", ctx);
  assert.ok(menu.render(120).join("\n").includes("Global"));
  assert.ok(!menu.render(120).join("\n").includes("Project"));

  menu.handleInput("\t");
  assert.ok(!menu.render(120).join("\n").includes("Project"));
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf-8")), projectSettings);
});

test("startup patch colors the built-in skill list from effective settings", async () => {
  const cwd = await mkdtemp(join(home, "startup-colors-"));
  await writeSettings(globalSettingsPath, { skillful: { hiddenSkills: ["hidden"] } });

  const { handlers } = registerVisibility();
  const theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
  };
  await handlers.get("session_start")(
    { reason: "startup" },
    { cwd, isProjectTrusted: () => false, ui: { theme } },
  );

  const prototype = {
    showLoadedResources() {
      const { skills } = this.session.resourceLoader.getSkills();
      const names = skills.map(({ name }) => name).sort().join(", ");
      this.loadedResourcesContainer.children.push({
        getCollapsedText: () => `[Skills]\n  ${names}`,
        setText(text) {
          this.text = text;
        },
      });
    },
  };
  installStartupSkillListPatch(prototype);

  const instance = Object.assign(Object.create(prototype), {
    loadedResourcesContainer: { children: [] },
    session: {
      resourceLoader: {
        getSkills: () => ({ skills: [skill("visible"), skill("hidden")], diagnostics: [] }),
      },
    },
    sessionManager: { getCwd: () => cwd },
  });
  instance.showLoadedResources();

  const rendered = instance.loadedResourcesContainer.children[0];
  assert.equal(
    rendered.text,
    "<mdHeading>[Skills]</mdHeading>\n  <error>hidden</error>, <dim>visible</dim>",
  );
  assert.equal(rendered.getCollapsedText(), rendered.text);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
