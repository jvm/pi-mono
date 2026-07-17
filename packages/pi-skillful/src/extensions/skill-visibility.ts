import {
  DynamicBorder,
  getSettingsListTheme,
  InteractiveMode,
  type ExtensionAPI,
  type Skill,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type SettingItem, SettingsList, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
  normalizeSkillName,
  normalizeSkillNames,
  readEffectiveHiddenSkills,
  readScopedSkillfulSettings,
  SKILL_TOGGLE_SLOTS,
  type SkillfulScope,
  type SkillToggleSlot,
  writeHiddenSkills,
  writeProjectSkillfulOverride,
  writeToggleSlots,
} from "../config.js";
import { replaceSkillsSection } from "../skill-prompt.js";
import { isTopLevelSkill, listLoadedSkills, type LoadedSkillInfo } from "../skills.js";
import { hasActiveSessionSkillToggles, refreshSessionSkillToggles } from "./session-skill-toggles.js";
const SCOPES: SkillfulScope[] = ["global", "project"];
const STORE_KEY = Symbol.for("pi-skillful.skillVisibilityStore");
const STARTUP_PATCH_KEY = Symbol.for("pi-skillful.startupPatchV3");

interface SkillVisibilityStore {
  hiddenSkillsByCwd: Map<string, Set<string>>;
  theme: Theme | null;
}

interface ExpandableTextLike {
  getCollapsedText: () => string;
  setText: (text: string) => void;
}

interface BoxLike {
  children: unknown[];
}

interface InteractiveModeLike {
  loadedResourcesContainer?: BoxLike;
  showLoadedResources?: (options?: unknown) => void;
  session?: { resourceLoader?: { getSkills: () => { skills: Skill[]; diagnostics: unknown[] } } };
  sessionManager?: { getCwd?: () => string };
}

const store = (((globalThis as Record<PropertyKey, unknown>)[STORE_KEY] as SkillVisibilityStore | undefined) ??= {
  hiddenSkillsByCwd: new Map<string, Set<string>>(),
  theme: null,
}) as SkillVisibilityStore;

type SkillListItem = LoadedSkillInfo;
type HiddenSkillsByScope = Record<SkillfulScope, Set<string>>;
type ToggleSlotsByScope = Record<SkillfulScope, Partial<Record<SkillToggleSlot, string>>>;
type DefinedByScope = Record<SkillfulScope, boolean>;

interface SkillfulVisibilityMenuOptions {
  cwd: string;
  projectTrusted: boolean;
  skills: SkillListItem[];
  hiddenByScope: HiddenSkillsByScope;
  hiddenSkillsDefinedByScope: DefinedByScope;
  toggleSlotsByScope: ToggleSlotsByScope;
  toggleSlotsDefinedByScope: DefinedByScope;
  theme: Theme;
  tui: TUI;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  onToggleSlotsChanged: () => Promise<void>;
  done: () => void;
}

interface SettingsListSelectionView {
  filteredItems?: SettingItem[];
  items?: SettingItem[];
  selectedIndex?: number;
  submenuComponent?: unknown;
}

export default function skillVisibility(pi: ExtensionAPI) {
  installStartupSkillListPatch();

  pi.on("session_start", async (_event, ctx) => {
    store.theme = ctx.ui.theme;
    await refreshHiddenSkillCache(ctx.cwd, ctx.isProjectTrusted());
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (hasActiveSessionSkillToggles()) return;

    const hidden = await refreshHiddenSkillCache(ctx.cwd, ctx.isProjectTrusted());
    if (hidden.size === 0 || !event.systemPromptOptions.skills?.length) return;

    const filteredSkills: Skill[] = event.systemPromptOptions.skills.map((skill) =>
      isTopLevelSkill(skill) && hidden.has(skill.name) ? { ...skill, disableModelInvocation: true } : skill,
    );
    const systemPrompt = replaceSkillsSection(event.systemPrompt, filteredSkills);
    if (!systemPrompt) return;
    return { systemPrompt };
  });

  pi.registerCommand("skillful", {
    description: "Open the pi-skillful skill visibility menu.",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/skillful requires interactive UI", "warning");
        return;
      }

      const skills = getSkillItems(pi);
      if (skills.length === 0) {
        ctx.ui.notify("No skills are currently loaded.", "info");
        return;
      }

      const projectTrusted = ctx.isProjectTrusted();
      const scoped = await readScopedSkillfulSettings(ctx.cwd, projectTrusted);
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
        new SkillfulVisibilityMenu({
          cwd: ctx.cwd,
          projectTrusted,
          skills,
          hiddenByScope: {
            global: new Set(scoped.global.hiddenSkills),
            project: new Set(scoped.project.hiddenSkills),
          },
          hiddenSkillsDefinedByScope: {
            global: scoped.global.hiddenSkillsDefined,
            project: scoped.project.hiddenSkillsDefined,
          },
          toggleSlotsByScope: {
            global: { ...scoped.global.toggleSlots },
            project: { ...scoped.project.toggleSlots },
          },
          toggleSlotsDefinedByScope: {
            global: scoped.global.toggleSlotsDefined,
            project: scoped.project.toggleSlotsDefined,
          },
          theme,
          tui,
          notify: (message, type) => ctx.ui.notify(message, type),
          onToggleSlotsChanged: () => refreshSessionSkillToggles(pi, ctx.cwd, projectTrusted, ctx.ui),
          done,
        }),
      );
    },
  });
}

async function refreshHiddenSkillCache(cwd: string, projectTrusted: boolean): Promise<Set<string>> {
  const hidden = await readEffectiveHiddenSkills(cwd, projectTrusted);
  store.hiddenSkillsByCwd.set(cwd, hidden);
  return hidden;
}

// Pi has no public hook for styling the built-in startup resource list, so patch the
// prototype from Pi's own module and keep the workaround isolated here.
export function installStartupSkillListPatch(
  realPrototype: InteractiveModeLike = (InteractiveMode as unknown as { prototype: InteractiveModeLike }).prototype,
): void {
  if (!realPrototype) return;

  const patchState = realPrototype as Record<PropertyKey, unknown>;
  if (patchState[STARTUP_PATCH_KEY]) return;

  const original = realPrototype.showLoadedResources;
  if (typeof original !== "function") return;

  realPrototype.showLoadedResources = function (this: InteractiveModeLike, options?: unknown): void {
    const loader = this.session?.resourceLoader;
    const originalGetSkills = loader?.getSkills;
    if (!loader || typeof originalGetSkills !== "function") {
      original.call(this, options);
      return;
    }

    const cwd = this.sessionManager?.getCwd?.();
    let rawSkillNames: string[] = [];
    loader.getSkills = () => {
      const result = originalGetSkills.call(loader);
      rawSkillNames = result.skills.map((skill) => normalizeSkillName(skill.name));
      return result;
    };

    const childrenBefore = this.loadedResourcesContainer?.children.length ?? 0;
    try {
      original.call(this, options);
    } finally {
      loader.getSkills = originalGetSkills;
    }

    if (rawSkillNames.length === 0 || !cwd || !this.loadedResourcesContainer) return;

    const hidden = store.hiddenSkillsByCwd.get(cwd) ?? new Set<string>();
    const children = this.loadedResourcesContainer.children;
    for (let index = childrenBefore; index < children.length; index++) {
      const child = children[index] as ExpandableTextLike | undefined;
      if (!child || typeof child.getCollapsedText !== "function") continue;
      if (!child.getCollapsedText().includes("[Skills]")) continue;

      const colorized = buildColorizedSkillList(rawSkillNames, hidden, store.theme);
      child.getCollapsedText = () => colorized;
      child.setText(colorized);
      break;
    }
  };

  patchState[STARTUP_PATCH_KEY] = true;
}

export function buildColorizedSkillList(names: string[], hidden: Set<string>, theme: Theme | null): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (!theme) return `[Skills]\n  ${sorted.join(", ")}`;

  const header = theme.fg("mdHeading", "[Skills]");
  const parts = sorted.map((name) => (hidden.has(name) ? theme.fg("error", name) : theme.fg("dim", name)));
  return `${header}\n  ${parts.join(", ")}`;
}

function getSkillItems(pi: ExtensionAPI): SkillListItem[] {
  return listLoadedSkills(pi.getCommands()).filter(isTopLevelSkill);
}

class SkillfulVisibilityMenu implements Component {
  private readonly cwd: string;
  private readonly projectTrusted: boolean;
  private readonly scopes: SkillfulScope[];
  private readonly skills: SkillListItem[];
  private readonly hiddenByScope: HiddenSkillsByScope;
  private readonly hiddenSkillsDefinedByScope: DefinedByScope;
  private readonly toggleSlotsByScope: ToggleSlotsByScope;
  private readonly toggleSlotsDefinedByScope: DefinedByScope;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
  private readonly onToggleSlotsChanged: () => Promise<void>;
  private readonly done: () => void;
  private readonly topBorder: DynamicBorder;
  private readonly bottomBorder: DynamicBorder;
  private scope: SkillfulScope;
  private settingsList: SettingsList;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(options: SkillfulVisibilityMenuOptions) {
    this.cwd = options.cwd;
    this.projectTrusted = options.projectTrusted;
    this.scopes = options.projectTrusted ? SCOPES : ["global"];
    this.scope = options.projectTrusted ? "project" : "global";
    this.skills = options.skills;
    this.hiddenByScope = options.hiddenByScope;
    this.hiddenSkillsDefinedByScope = options.hiddenSkillsDefinedByScope;
    this.toggleSlotsByScope = options.toggleSlotsByScope;
    this.toggleSlotsDefinedByScope = options.toggleSlotsDefinedByScope;
    this.theme = options.theme;
    this.tui = options.tui;
    this.notify = options.notify;
    this.onToggleSlotsChanged = options.onToggleSlotsChanged;
    this.done = options.done;
    this.topBorder = new DynamicBorder((text: string) => this.theme.fg("accent", text));
    this.bottomBorder = new DynamicBorder((text: string) => this.theme.fg("accent", text));
    this.settingsList = this.createSettingsList();
  }

  render(width: number): string[] {
    return [
      ...this.topBorder.render(width),
      truncateToWidth(`  ${this.theme.bold(this.theme.fg("accent", "pi-skillful"))}  ${this.renderTabs()}`, width),
      truncateToWidth(this.theme.fg("dim", "  Toggle skills shown in the model-invocation system prompt"), width),
      "",
      ...this.settingsList.render(width),
      "",
      truncateToWidth(this.theme.fg("dim", this.renderHelp()), width),
      ...this.bottomBorder.render(width),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.switchScope(1);
      return;
    }
    if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.left)) {
      this.switchScope(-1);
      return;
    }
    if (/^[1-9]$/.test(data)) {
      this.toggleSelectedSkillSlot(data as SkillToggleSlot);
      return;
    }

    this.settingsList.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.topBorder.invalidate();
    this.bottomBorder.invalidate();
    this.settingsList.invalidate();
  }

  private renderTabs(): string {
    return this.scopes
      .map((scope) => {
        const label = scope === "global" ? "Global" : "Project";
        return scope === this.scope
          ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${label} `))
          : this.theme.fg("muted", ` ${label} `);
      })
      .join(" ");
  }

  private renderHelp(): string {
    const scopeHelp = this.projectTrusted ? "Tab/←/→ switch scope · " : "";
    return `  ${scopeHelp}1-9 assign/clear toggle · Enter/Space on/off · Esc close`;
  }

  private switchScope(direction: 1 | -1): void {
    const current = this.scopes.indexOf(this.scope);
    this.scope = this.scopes[(current + direction + this.scopes.length) % this.scopes.length];
    this.settingsList = this.createSettingsList();
    this.tui.requestRender();
  }

  private createSettingsList(): SettingsList {
    const items: SettingItem[] = this.skills.map((skill) => {
      const hidden = this.isHidden(this.scope, skill.name);
      return {
        id: skill.name,
        label: skill.name,
        description: `${skill.description || "No skill description provided."}\nPress 1-9 to assign or clear this skill's toggle slot in the ${this.scope} scope.`,
        currentValue: this.skillValue(skill.name, hidden),
        values: [this.skillValue(skill.name, false), this.skillValue(skill.name, true)],
      };
    });

    return new SettingsList(
      items,
      12,
      getSettingsListTheme(),
      (id, newValue) => {
        this.setHidden(this.scope, id, newValue.includes("off"));
        this.settingsList.updateValue(id, this.skillValue(id, this.isHidden(this.scope, id)));
        this.persistScope(this.scope);
      },
      () => this.close(),
      { enableSearch: true },
    );
  }

  private isHidden(scope: SkillfulScope, skillName: string): boolean {
    if (scope === "project" && !this.hiddenSkillsDefinedByScope.project) return this.hiddenByScope.global.has(skillName);
    return this.hiddenByScope[scope].has(skillName);
  }

  private setHidden(scope: SkillfulScope, skillName: string, hidden: boolean): void {
    const hiddenSkills = scope === "project" ? this.ensureFullProjectOverride().hiddenSkills : this.ensureWritableHiddenSkills(scope);
    if (hidden) hiddenSkills.add(skillName);
    else hiddenSkills.delete(skillName);
  }

  private ensureWritableHiddenSkills(scope: SkillfulScope): Set<string> {
    if (scope === "global") this.hiddenSkillsDefinedByScope.global = true;
    return this.hiddenByScope[scope];
  }

  private ensureFullProjectOverride(): { hiddenSkills: Set<string>; toggleSlots: Partial<Record<SkillToggleSlot, string>> } {
    if (!this.hiddenSkillsDefinedByScope.project) {
      this.hiddenByScope.project = new Set(this.hiddenByScope.global);
      this.hiddenSkillsDefinedByScope.project = true;
    }
    if (!this.toggleSlotsDefinedByScope.project) {
      this.toggleSlotsByScope.project = { ...this.toggleSlotsByScope.global };
      this.toggleSlotsDefinedByScope.project = true;
    }
    return { hiddenSkills: this.hiddenByScope.project, toggleSlots: this.toggleSlotsByScope.project };
  }

  private skillValue(skillName: string, hidden: boolean): string {
    const slot = SKILL_TOGGLE_SLOTS.find((candidate) => this.currentToggleSlots()[candidate] === skillName) ?? "";
    const status = (hidden ? "off" : "on").padEnd(3, " ");
    const statusText = this.isProjectOverride(skillName) ? this.theme.fg("accent", status) : status;
    return `${statusText}   ${slot}`;
  }

  private currentToggleSlots(): Partial<Record<SkillToggleSlot, string>> {
    if (this.scope === "project" && !this.toggleSlotsDefinedByScope.project) return this.toggleSlotsByScope.global;
    return this.toggleSlotsByScope[this.scope];
  }

  private ensureWritableToggleSlots(scope: SkillfulScope): Partial<Record<SkillToggleSlot, string>> {
    if (scope === "project") return this.ensureFullProjectOverride().toggleSlots;
    this.toggleSlotsDefinedByScope.global = true;
    return this.toggleSlotsByScope.global;
  }

  private isProjectOverride(skillName: string): boolean {
    if (this.scope !== "project") return false;
    return this.isHidden("project", skillName) !== this.isHidden("global", skillName);
  }

  private toggleSelectedSkillSlot(slot: SkillToggleSlot): void {
    const skillName = this.selectedSkillName();
    if (!skillName) return;

    const toggleSlots = this.ensureWritableToggleSlots(this.scope);
    const affected = new Set<string>([skillName]);
    const previousSkill = toggleSlots[slot];
    if (previousSkill) affected.add(previousSkill);

    if (previousSkill === skillName) {
      delete toggleSlots[slot];
    } else {
      for (const candidate of SKILL_TOGGLE_SLOTS) {
        if (toggleSlots[candidate] === skillName) delete toggleSlots[candidate];
      }
      toggleSlots[slot] = skillName;
    }

    for (const affectedSkill of affected) {
      this.settingsList.updateValue(affectedSkill, this.skillValue(affectedSkill, this.isHidden(this.scope, affectedSkill)));
    }
    this.persistToggleSlots(this.scope);
    this.tui.requestRender();
  }

  private selectedSkillName(): string | undefined {
    const list = this.settingsList as unknown as SettingsListSelectionView;
    if (list.submenuComponent) return undefined;
    const items = list.filteredItems ?? list.items ?? [];
    const selectedIndex = list.selectedIndex ?? 0;
    return items[selectedIndex]?.id;
  }

  private persistScope(scope: SkillfulScope): void {
    const hiddenSnapshot = normalizeSkillNames(this.hiddenByScope[scope]);
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        if (scope === "project") await this.writeProjectOverrideOrInheritance();
        else await writeHiddenSkills(scope, this.cwd, hiddenSnapshot);
        await refreshHiddenSkillCache(this.cwd, this.projectTrusted);
      })
      .catch((error) => {
        this.notify(`Failed to save ${scope} skill visibility: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
  }

  private persistToggleSlots(scope: SkillfulScope): void {
    const snapshot = { ...this.toggleSlotsByScope[scope] };
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        if (scope === "project") await this.writeProjectOverrideOrInheritance();
        else await writeToggleSlots(scope, this.cwd, snapshot);
      })
      .catch((error) => {
        this.notify(`Failed to save ${scope} skill toggles: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
  }

  private close(): void {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => this.onToggleSlotsChanged())
      .catch((error) => {
        this.notify(`Failed to refresh session skill toggles: ${error instanceof Error ? error.message : String(error)}`, "error");
      })
      .finally(() => this.done());
  }

  private async writeProjectOverrideOrInheritance(): Promise<void> {
    if (this.projectMatchesGlobal()) {
      this.hiddenSkillsDefinedByScope.project = false;
      this.toggleSlotsDefinedByScope.project = false;
      await writeProjectSkillfulOverride(this.cwd, undefined, undefined, this.projectTrusted);
      return;
    }

    this.hiddenSkillsDefinedByScope.project = true;
    this.toggleSlotsDefinedByScope.project = true;
    await writeProjectSkillfulOverride(
      this.cwd,
      this.hiddenByScope.project,
      this.toggleSlotsByScope.project,
      this.projectTrusted,
    );
  }

  private projectMatchesGlobal(): boolean {
    return setsEqual(this.hiddenByScope.project, this.hiddenByScope.global) && toggleSlotsEqual(this.toggleSlotsByScope.project, this.toggleSlotsByScope.global);
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function toggleSlotsEqual(
  a: Partial<Record<SkillToggleSlot, string>>,
  b: Partial<Record<SkillToggleSlot, string>>,
): boolean {
  for (const slot of SKILL_TOGGLE_SLOTS) {
    if (a[slot] !== b[slot]) return false;
  }
  return true;
}
