import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Skill, type Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_TOGGLE_MODIFIER,
  normalizeSkillName,
  readEffectiveSkillfulSettings,
  SKILL_TOGGLE_SLOTS,
  SUPPORTED_TOGGLE_MODIFIERS,
  type SkillToggleModifier,
  type SkillToggleSlot,
} from "../config.js";
import { replaceSkillsSection } from "../skill-prompt.js";
import { isTopLevelSkill, listLoadedSkills } from "../skills.js";

const WIDGET_KEY = "pi-skillful-session-toggles";
const STORE_KEY = Symbol.for("pi-skillful.sessionSkillTogglesStore");
const BORDER_PREFIX = "─── ";
const BORDER_SUFFIX = " ";
const BORDER_PREFIX_WIDTH = visibleWidth(BORDER_PREFIX);
const BORDER_SUFFIX_WIDTH = visibleWidth(BORDER_SUFFIX);
const MAX_SLOT_NAME_WIDTH = 16;

interface ToggleSlotState {
  slot: SkillToggleSlot;
  skillName: string;
}

interface SessionToggleState {
  cwd: string;
  modifier: SkillToggleModifier;
  hiddenSkills: Set<string>;
  slots: ToggleSlotState[];
  activeBySkill: Map<string, boolean>;
  installedEditor: boolean;
  installedWidget: boolean;
  previousEditorFactory: SkillfulEditorFactory | undefined;
  activeTui: TUI | undefined;
  theme: Theme | undefined;
}

interface SessionToggleStore {
  preservedNewSessionActiveBySkill: { cwd: string; activeBySkill: Map<string, boolean> } | undefined;
}

const store = (((globalThis as Record<PropertyKey, unknown>)[STORE_KEY] as SessionToggleStore | undefined) ??= {
  preservedNewSessionActiveBySkill: undefined,
}) as SessionToggleStore;

let state: SessionToggleState = createEmptyState();

export default function sessionSkillToggles(pi: ExtensionAPI) {
  for (const modifier of SUPPORTED_TOGGLE_MODIFIERS) {
    for (const slot of SKILL_TOGGLE_SLOTS) {
      pi.registerShortcut(`${modifier}+${slot}`, {
        description: `Toggle pi-skillful slot ${slot}`,
        handler: (ctx) => {
          if (state.modifier !== modifier) return;
          toggleSlot(slot, ctx.ui.notify.bind(ctx.ui));
        },
      });
    }
  }

  pi.on("session_start", async (event, ctx) => {
    const settings = await readEffectiveSkillfulSettings(ctx.cwd);
    const slots = configuredToggleSlots(pi, settings.toggleSlots);

    const preservedActiveBySkill =
      event.reason === "new" && store.preservedNewSessionActiveBySkill?.cwd === ctx.cwd
        ? store.preservedNewSessionActiveBySkill.activeBySkill
        : undefined;
    store.preservedNewSessionActiveBySkill = undefined;

    state = {
      cwd: ctx.cwd,
      modifier: settings.toggleModifier,
      hiddenSkills: settings.hiddenSkillSet,
      slots,
      activeBySkill: new Map(
        slots.map(({ skillName }) => [
          skillName,
          preservedActiveBySkill?.get(skillName) ?? !settings.hiddenSkillSet.has(skillName),
        ]),
      ),
      installedEditor: false,
      installedWidget: false,
      previousEditorFactory: undefined,
      activeTui: undefined,
      theme: ctx.ui.theme,
    };

    if (ctx.hasUI && slots.length > 0) installEditor(ctx.ui);
    refreshUi();
  });

  pi.on("before_agent_start", (event) => {
    if (state.slots.length === 0 || !event.systemPromptOptions.skills?.length) return;

    const updatedSkills: Skill[] = event.systemPromptOptions.skills.map((skill) =>
      isTopLevelSkill(skill) ? { ...skill, disableModelInvocation: !isSkillActive(normalizeSkillName(skill.name)) } : skill,
    );

    const systemPrompt = replaceSkillsSection(event.systemPrompt, updatedSkills);
    if (!systemPrompt) return;
    return { systemPrompt };
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (state.installedEditor) ctx.ui.setEditorComponent(state.previousEditorFactory);
    if (state.installedWidget) ctx.ui.setWidget(WIDGET_KEY, undefined);
    store.preservedNewSessionActiveBySkill =
      event.reason === "new" ? { cwd: state.cwd, activeBySkill: new Map(state.activeBySkill) } : undefined;
    state = createEmptyState();
  });
}

function createEmptyState(): SessionToggleState {
  return {
    cwd: "",
    modifier: DEFAULT_TOGGLE_MODIFIER,
    hiddenSkills: new Set<string>(),
    slots: [],
    activeBySkill: new Map<string, boolean>(),
    installedEditor: false,
    installedWidget: false,
    previousEditorFactory: undefined,
    activeTui: undefined,
    theme: undefined,
  };
}

export function hasActiveSessionSkillToggles(): boolean {
  return state.slots.length > 0;
}

export async function refreshSessionSkillToggles(pi: ExtensionAPI, cwd: string, ui: SkillfulUi): Promise<void> {
  const settings = await readEffectiveSkillfulSettings(cwd);
  const slots = configuredToggleSlots(pi, settings.toggleSlots);

  const previousActiveBySkill = state.activeBySkill;
  state.modifier = settings.toggleModifier;
  state.hiddenSkills = settings.hiddenSkillSet;
  state.slots = slots;
  state.activeBySkill = new Map(
    slots.map(({ skillName }) => [skillName, previousActiveBySkill.get(skillName) ?? !settings.hiddenSkillSet.has(skillName)]),
  );

  if (slots.length > 0 && !state.installedEditor && !state.installedWidget) {
    installEditor(ui);
  } else if (slots.length === 0) {
    if (state.installedEditor) ui.setEditorComponent(state.previousEditorFactory);
    if (state.installedWidget) ui.setWidget(WIDGET_KEY, undefined);
    state.installedEditor = false;
    state.installedWidget = false;
    state.previousEditorFactory = undefined;
  }

  refreshUi();
}

function configuredToggleSlots(
  pi: ExtensionAPI,
  toggleSlots: Partial<Record<SkillToggleSlot, string>>,
): ToggleSlotState[] {
  const loadedSkillNames = new Set(
    listLoadedSkills(pi.getCommands())
      .filter(isTopLevelSkill)
      .map((skill) => skill.name),
  );
  return SKILL_TOGGLE_SLOTS.flatMap((slot): ToggleSlotState[] => {
    const skillName = toggleSlots[slot];
    if (!skillName || !loadedSkillNames.has(skillName)) return [];
    return [{ slot, skillName }];
  });
}

function isSkillActive(skillName: string): boolean {
  return state.activeBySkill.get(skillName) ?? !state.hiddenSkills.has(skillName);
}

function toggleSlot(slot: SkillToggleSlot, notify: (message: string, type?: "info" | "warning" | "error") => void): void {
  const entry = state.slots.find((candidate) => candidate.slot === slot);
  if (!entry) {
    notify(`No pi-skillful skill assigned to slot ${slot}.`, "info");
    return;
  }

  const next = !isSkillActive(entry.skillName);
  state.activeBySkill.set(entry.skillName, next);
  notify(`${entry.skillName} ${next ? "active" : "inactive"} for this session.`, "info");
  refreshUi();
}

type SkillfulEditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type SkillfulUi = {
  getEditorComponent: () => SkillfulEditorFactory | undefined;
  setEditorComponent: (factory: SkillfulEditorFactory | undefined) => void;
  setWidget: (
    key: string,
    content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ) => void;
};

function installEditor(ui: SkillfulUi): void {
  state.previousEditorFactory = ui.getEditorComponent();

  try {
    const previous = state.previousEditorFactory;
    ui.setEditorComponent((tui, theme, keybindings) => {
      state.activeTui = tui;
      if (previous) return new SkillToggleEditorWrapper(previous(tui, theme, keybindings));
      return new SkillToggleEditor(tui, theme, keybindings);
    });
    state.installedEditor = true;
  } catch {
    ui.setWidget(WIDGET_KEY, (tui) => {
      state.activeTui = tui;
      return new SkillToggleWidget();
    });
    state.installedWidget = true;
  }
}

function refreshUi(): void {
  state.activeTui?.requestRender();
}

class SkillToggleEditor extends CustomEditor {
  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    lines[0] = renderToggleBorder(width, (text) => this.borderColor(text));
    return lines;
  }
}

class SkillToggleEditorWrapper implements EditorComponent {
  borderColor?: (str: string) => string;

  constructor(private readonly inner: EditorComponent) {
    this.borderColor = inner.borderColor?.bind(inner);
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.inner.onSubmit;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.inner.onSubmit = handler;
  }

  get onChange(): ((text: string) => void) | undefined {
    return this.inner.onChange;
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this.inner.onChange = handler;
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    if (lines.length === 0) return lines;
    lines[0] = renderToggleBorder(width, this.borderColor ?? ((text) => text));
    return lines;
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  getText(): string {
    return this.inner.getText();
  }

  setText(text: string): void {
    this.inner.setText(text);
  }

  handleInput(data: string): void {
    this.inner.handleInput(data);
  }

  addToHistory(text: string): void {
    this.inner.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    this.inner.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.inner.getExpandedText?.() ?? this.inner.getText();
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.inner.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.inner.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.inner.setAutocompleteMaxVisible?.(maxVisible);
  }

  dispose(): void {
    (this.inner as EditorComponent & { dispose?(): void }).dispose?.();
  }
}

class SkillToggleWidget implements Component {
  render(width: number): string[] {
    return [renderToggleBorder(width, (text) => text)];
  }

  invalidate(): void {}
}

function renderToggleBorder(width: number, borderColor: (text: string) => string): string {
  if (width <= 0) return "";
  if (state.slots.length === 0) return borderColor("─".repeat(width));

  const available = Math.max(0, width - BORDER_PREFIX_WIDTH - BORDER_SUFFIX_WIDTH);
  const fittedContent = truncateToWidth(renderToggleSegments(available), available, "");
  const used = BORDER_PREFIX_WIDTH + visibleWidth(fittedContent) + BORDER_SUFFIX_WIDTH;
  const fill = borderColor("─".repeat(Math.max(0, width - used)));
  return `${borderColor(BORDER_PREFIX)}${fittedContent}${BORDER_SUFFIX}${fill}`;
}

function renderToggleSegments(availableWidth: number): string {
  const separatorWidth = Math.max(0, state.slots.length - 1) * 2;
  const slotLabelWidth = state.slots.length * 2;
  const fullNameWidth = state.slots.reduce((total, slot) => total + visibleWidth(slot.skillName), 0);
  const truncate = separatorWidth + slotLabelWidth + fullNameWidth > availableWidth;
  const maxNameWidth = Math.max(
    1,
    Math.min(MAX_SLOT_NAME_WIDTH, Math.floor((availableWidth - separatorWidth - slotLabelWidth) / Math.max(1, state.slots.length))),
  );

  return state.slots
    .map(({ slot, skillName }) => {
      const name = truncate ? truncateToWidth(skillName, maxNameWidth, "…") : skillName;
      const text = `${slot} ${name}`;
      return stateThemeFg(isSkillActive(skillName) ? "accent" : "muted", text);
    })
    .join("  ");
}

function stateThemeFg(color: "accent" | "muted", text: string): string {
  return state.theme?.fg(color, text) ?? text;
}
