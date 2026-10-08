import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { formatSkillsForPrompt, initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";

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
    const event = { systemPrompt: "Unrelated prompt text", systemPromptOptions: { skills } };
    assert.equal(await handlers.get("before_agent_start")(event, ctx), undefined);
    const prompt = formatSkillsForPrompt(event.systemPromptOptions.skills);
    assert.ok(prompt.includes(`<name>${projectSkill.name}</name>`));
    assert.ok(!prompt.includes(`<name>${globalSkill.name}</name>`));
    assert.equal(event.systemPrompt, "Unrelated prompt text");
    assert.equal(skills[0].disableModelInvocation, undefined);
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
  const event = { systemPromptOptions: { skills } };
  assert.equal(await handlers.get("before_agent_start")(event, ctx), undefined);
  const prompt = formatSkillsForPrompt(event.systemPromptOptions.skills);
  assert.ok(prompt.includes(`<name>${globalSkill.name}</name>`));
  assert.ok(!prompt.includes(`<name>${projectSkill.name}</name>`));
});

test("visibility preserves package skills, earlier restrictions, and explicit prompt overrides", async () => {
  await writeSettings(globalSettingsPath, { skillful: { hiddenSkills: ["hidden", "bundled"] } });
  const hidden = skill("hidden");
  const bundled = { ...skill("bundled"), sourceInfo: { ...skill("bundled").sourceInfo, origin: "package" } };
  const restricted = { ...skill("restricted"), disableModelInvocation: true };
  const { handlers } = registerVisibility();
  const event = {
    systemPrompt: "Explicit policy.",
    systemPromptOptions: {
      skills: [hidden, bundled, restricted], forceSystemPrompt: "Explicit policy.",
      sections: { unrelated: "Leave this alone." },
    },
  };
  assert.equal(await handlers.get("before_agent_start")(event, { cwd: home, isProjectTrusted: () => false }), undefined);
  assert.equal(event.systemPromptOptions.skills[0].disableModelInvocation, true);
  assert.equal(event.systemPromptOptions.skills[1], bundled);
  assert.equal(event.systemPromptOptions.skills[2], restricted);
  assert.equal(hidden.disableModelInvocation, undefined);
  assert.equal(event.systemPromptOptions.forceSystemPrompt, "Explicit policy.");
  assert.deepEqual(event.systemPromptOptions.sections, { unrelated: "Leave this alone." });
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

test("startup patch retains support for the legacy resource component", async () => {
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
    [Symbol.for("pi-skillful.startupPatchV3")]: true,
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

test("real Pi startup renderer preserves colors through themes, expansion, and reload", async () => {
  const cwd = await mkdtemp(join(home, "real-startup-"));
  await writeSettings(globalSettingsPath, { skillful: { hiddenSkills: ["hidden"] } });
  let { handlers } = registerVisibility();
  let palette = "first";
  const ctx = {
    cwd,
    mode: "tui",
    isProjectTrusted: () => false,
    ui: {
      get theme() {
        const name = palette;
        return { fg: (color, text) => `<${name}:${color}>${text}</${name}:${color}>` };
      },
    },
  };
  await handlers.get("session_start")({ reason: "startup" }, ctx);

  const skills = [skill("visible"), skill("hidden")];
  const getSkills = () => ({ skills, diagnostics: [] });
  let expanded = false;
  const instance = {
    loadedResourcesContainer: new Container(),
    sessionManager: { getCwd: () => cwd },
    session: {
      promptTemplates: [],
      resourceLoader: {
        getSkills,
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getExtensions: () => ({ extensions: [], errors: [], warnings: [] }),
        getSystemPromptSource: () => undefined,
        getAppendSystemPromptSources: () => [],
        getAgentsFiles: () => ({ agentsFiles: [{ path: join(cwd, "AGENTS.md") }] }),
      },
      extensionRunner: {
        getCommandDiagnostics: () => [],
        getShortcutDiagnostics: () => [],
      },
    },
    getStartupExpansionState: () => expanded,
    shouldShowStartupDetails: () => false,
    buildScopeGroups: () => [],
    formatScopeGroups: () => "  native expanded skill paths",
    formatDisplayPath: (path) => path,
    formatContextPath: () => "AGENTS.md",
    getBuiltInCommandConflictDiagnostics: () => [],
  };
  const showResources = () => {
    // Exercise the installed Pi renderer and the extension's factory wiring,
    // not a mock of the private component contract.
    InteractiveMode.prototype.showLoadedResources.call(instance, { force: true });
    assert.equal(instance.session.resourceLoader.getSkills, getSkills);
  };
  const render = () => instance.loadedResourcesContainer.render(200).join("\n");
  const skillsSection = () => instance.loadedResourcesContainer.children.find(
    (child) => stripVTControlCharacters(child.render(200).join("\n")).includes("[Skills]"),
  );

  showResources();
  assert.ok(render().includes("<first:error>hidden</first:error>"));
  assert.ok(render().includes("<first:dim>visible</first:dim>"));
  assert.ok(stripVTControlCharacters(render()).includes("[Context]"));
  assert.ok(stripVTControlCharacters(render()).includes("AGENTS.md"));

  palette = "second";
  instance.loadedResourcesContainer.invalidate();
  assert.ok(render().includes("<second:error>hidden</second:error>"));
  assert.ok(!render().includes("<first:"));
  for (const line of instance.loadedResourcesContainer.render(40)) {
    assert.ok(visibleWidth(line) <= 40);
  }

  skillsSection().setExpanded(true);
  assert.ok(render().includes("native expanded skill paths"));
  assert.ok(!render().includes("<second:error>"));
  skillsSection().setExpanded(false);
  assert.ok(render().includes("<second:error>hidden</second:error>"));

  // A reload clears and rebuilds the populated container. It must not stack
  // prototype wrappers or skip replacement children based on the old length.
  const patched = InteractiveMode.prototype.showLoadedResources;
  ({ handlers } = registerVisibility());
  assert.equal(InteractiveMode.prototype.showLoadedResources, patched);
  await writeSettings(globalSettingsPath, { skillful: { hiddenSkills: ["visible"] } });
  await handlers.get("session_start")({ reason: "reload" }, ctx);
  showResources();
  assert.ok(render().includes("<second:error>visible</second:error>"));
  assert.ok(render().includes("<second:dim>hidden</second:dim>"));

  expanded = true;
  showResources();
  assert.ok(render().includes("native expanded skill paths"));
  assert.ok(!render().includes("<second:error>"));
  skillsSection().setExpanded(false);
  assert.ok(render().includes("<second:error>visible</second:error>"));

  InteractiveMode.prototype.showLoadedResources.call(instance, { force: false });
  assert.equal(instance.loadedResourcesContainer.children.length, 0);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
