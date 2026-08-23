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
const defaultKeybindings = {
  matches: (data, binding) =>
    binding === "tui.select.confirm" ? data === "\r" : binding === "tui.select.cancel" && ["\x03", "\x1b"].includes(data),
  getKeys: (binding) => (binding === "tui.select.confirm" ? ["enter"] : ["escape", "ctrl+c"]),
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

for (const mode of ["tui", "rpc"]) {
  test(`untrusted projects expose only global settings in the menu in ${mode} mode`, async () => {
    const cwd = await mkdtemp(join(home, `menu-untrusted-${mode}-`));
    const loadedSkill = skill(`menu-skill-${mode}`);
    const projectPath = join(cwd, ".pi", "settings.json");
    const projectSettings = { skillful: { hiddenSkills: [loadedSkill.name] } };
    await writeSettings(globalSettingsPath, { skillful: {} });
    await writeSettings(projectPath, projectSettings);
    const { registeredCommands } = registerVisibility([commandForSkill(loadedSkill)]);
    let menu;
    const tui = { requestRender: () => undefined };
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => false,
      mode,
      ui: {
        custom: async (factory) => {
          menu = factory(tui, identityTheme, defaultKeybindings, () => undefined);
          return true;
        },
        notify: () => undefined,
      },
    };

    await registeredCommands.get("skillful").handler("", ctx);
    assert.ok(menu.render(120).join("\n").includes("Global"));
    assert.match(menu.render(120).join("\n"), /Enter details .* Space on\/off .* Esc\/Ctrl\+C close/);
    assert.equal(menu.render(120).join("\n").includes("\x1b[96m[Global]\x1b[39m"), mode === "rpc");
    assert.ok(!menu.render(120).join("\n").includes("Project"));

    menu.handleInput("\t");
    assert.ok(!menu.render(120).join("\n").includes("Project"));
    assert.deepEqual(JSON.parse(await readFile(projectPath, "utf-8")), projectSettings);
  });
}

test("RPC clients without custom component support receive a warning", async () => {
  const loadedSkill = skill("unsupported-rpc-menu");
  const { registeredCommands } = registerVisibility([commandForSkill(loadedSkill)]);
  const notifications = [];
  const ctx = {
    cwd: home,
    hasUI: true,
    isProjectTrusted: () => false,
    mode: "rpc",
    ui: {
      custom: async () => undefined,
      notify: (message, type) => notifications.push({ message, type }),
    },
  };

  await registeredCommands.get("skillful").handler("", ctx);

  assert.deepEqual(notifications, [{ message: "/skillful requires custom UI support", type: "warning" }]);
});

test("plain-text RPC menus color the active project and global scopes", async () => {
  const cwd = await mkdtemp(join(home, "menu-scopes-"));
  const { registeredCommands } = registerVisibility([commandForSkill(skill("menu-scopes-skill"))]);
  let menu;
  const tui = { requestRender: () => undefined };
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    mode: "rpc",
    ui: {
      custom: async (factory) => {
        menu = factory(tui, identityTheme, defaultKeybindings, () => undefined);
        return true;
      },
      notify: () => undefined,
    },
  };

  await registeredCommands.get("skillful").handler("", ctx);
  assert.ok(menu.render(120).join("\n").includes("\x1b[96m[Project]\x1b[39m"));
  assert.ok(!menu.render(120).join("\n").includes("[Global]"));

  menu.handleInput("\t");
  assert.ok(menu.render(120).join("\n").includes("\x1b[96m[Global]\x1b[39m"));
  assert.ok(!menu.render(120).join("\n").includes("[Project]"));
});

test("skill descriptions keep the menu height stable", async () => {
  const cwd = await mkdtemp(join(home, "menu-description-height-"));
  const shortSkill = skill("a-short-description");
  const longSkill = skill("b-long-description");
  shortSkill.description = "Short description.";
  longSkill.description = `${"Long description text ".repeat(40)}FULL DESCRIPTION END`;
  const { registeredCommands } = registerVisibility([shortSkill, longSkill].map(commandForSkill));
  let menu;
  const tui = { terminal: { rows: 10 }, requestRender: () => undefined };
  const detailBindings = {
    "tui.select.confirm": "\r",
    "tui.select.cancel": "q",
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.pageUp": "p",
    "tui.select.pageDown": "n",
  };
  const detailKeybindings = {
    matches: (data, binding) => detailBindings[binding] === data,
    getKeys: (binding) => (detailBindings[binding] ? [binding === "tui.select.confirm" ? "enter" : detailBindings[binding]] : []),
  };
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    mode: "tui",
    ui: {
      custom: async (factory) => {
        menu = factory(tui, identityTheme, detailKeybindings, () => undefined);
        return true;
      },
      notify: () => undefined,
    },
  };

  await registeredCommands.get("skillful").handler("", ctx);
  const shortRender = menu.render(40);
  menu.handleInput("\x1b[B");
  const longRender = menu.render(40);

  assert.match(shortRender.join("\n"), /Short description/);
  assert.match(longRender.join("\n"), /Long description text/);
  assert.equal(longRender.length, shortRender.length);
  assert.doesNotMatch(longRender.join("\n"), /FULL DESCRIPTION END|Enter\/Space to change/);
  assert.match(menu.render(180).join("\n"), /Enter details .* Q close/);

  menu.handleInput("b");
  menu.handleInput(" ");
  const filteredRender = menu.render(40);
  assert.match(filteredRender.join("\n"), /b-long-description.*off/);

  menu.handleInput("\r");
  const detailRender = menu.render(40);
  assert.equal(detailRender.length, tui.terminal.rows - 2);
  assert.match(detailRender[1], /b-long-description/);
  assert.doesNotMatch(detailRender.join("\n"), /FULL\s+DESCRIPTION END/);
  assert.match(detailRender.join("\n"), /Enter\/Q back · K\/J scroll/);

  menu.handleInput("\x1b");
  assert.doesNotMatch(menu.render(40).join("\n"), /FULL\s+DESCRIPTION END/);
  for (let page = 0; page < 20; page += 1) menu.handleInput("n");
  assert.match(menu.render(40).join("\n"), /FULL\s+DESCRIPTION END/);
  menu.handleInput("q");
  assert.equal(menu.render(40).length, filteredRender.length);
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
