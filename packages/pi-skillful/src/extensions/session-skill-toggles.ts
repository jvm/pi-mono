import {
  CustomEditor,
  type AppKeybinding,
  type ExtensionAPI,
  type KeybindingsManager,
  type Skill,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorComponent, EditorTheme, Focusable, KeyId, TUI } from "@earendil-works/pi-tui";
import { isFocusable, isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_TOGGLE_MODIFIER,
  normalizeSkillName,
  readEffectiveSkillfulSettings,
  SKILL_TOGGLE_SLOTS,
  type SkillToggleModifier,
  type SkillToggleSlot,
} from "../config.js";
import { replaceSkillsSection } from "../skill-prompt.js";
import { isTopLevelSkill, listLoadedSkills } from "../skills.js";

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
  previousEditorFactory: SkillfulEditorFactory | undefined;
  activeTui: TUI | undefined;
  theme: Theme | undefined;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
}

interface SessionToggleStore {
  preservedNewSessionActiveBySkill: { cwd: string; activeBySkill: Map<string, boolean> } | undefined;
}

const store = (((globalThis as Record<PropertyKey, unknown>)[STORE_KEY] as SessionToggleStore | undefined) ??= {
  preservedNewSessionActiveBySkill: undefined,
}) as SessionToggleStore;

let state: SessionToggleState = createEmptyState();

export default function sessionSkillToggles(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    const settings = await readEffectiveSkillfulSettings(ctx.cwd, ctx.isProjectTrusted());
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
      previousEditorFactory: undefined,
      activeTui: undefined,
      theme: ctx.ui.theme,
      notify: ctx.ui.notify.bind(ctx.ui),
    };

    if (ctx.mode === "tui" && slots.length > 0) installEditor(ctx.ui);
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
    previousEditorFactory: undefined,
    activeTui: undefined,
    theme: undefined,
    notify: () => undefined,
  };
}

export function hasActiveSessionSkillToggles(): boolean {
  return state.slots.length > 0;
}

export async function refreshSessionSkillToggles(
  pi: ExtensionAPI,
  cwd: string,
  projectTrusted: boolean,
  ui: SkillfulUi,
): Promise<void> {
  const settings = await readEffectiveSkillfulSettings(cwd, projectTrusted);
  const slots = configuredToggleSlots(pi, settings.toggleSlots);

  const previousActiveBySkill = state.activeBySkill;
  state.modifier = settings.toggleModifier;
  state.hiddenSkills = settings.hiddenSkillSet;
  state.slots = slots;
  state.activeBySkill = new Map(
    slots.map(({ skillName }) => [skillName, previousActiveBySkill.get(skillName) ?? !settings.hiddenSkillSet.has(skillName)]),
  );

  if (slots.length > 0 && !state.installedEditor) {
    installEditor(ui);
  } else if (slots.length === 0 && state.installedEditor) {
    ui.setEditorComponent(state.previousEditorFactory);
    state.installedEditor = false;
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

function handleToggleShortcut(data: string): boolean {
  const entry = state.slots.find(({ slot }) => matchesKey(data, `${state.modifier}+${slot}` as KeyId));
  if (!entry) return false;
  if (isKeyRelease(data) || isKeyRepeat(data)) return true;

  const next = !isSkillActive(entry.skillName);
  state.activeBySkill.set(entry.skillName, next);
  state.notify(`${entry.skillName} ${next ? "active" : "inactive"} for this session.`, "info");
  refreshUi();
  return true;
}

type SkillfulEditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type SkillfulUi = {
  getEditorComponent: () => SkillfulEditorFactory | undefined;
  setEditorComponent: (factory: SkillfulEditorFactory | undefined) => void;
};

function installEditor(ui: SkillfulUi): void {
  state.previousEditorFactory = ui.getEditorComponent();
  const previous = state.previousEditorFactory;
  ui.setEditorComponent((tui, theme, keybindings) => {
    state.activeTui = tui;
    if (previous) return new SkillToggleEditorWrapper(previous(tui, theme, keybindings));
    return new SkillToggleEditor(tui, theme, keybindings);
  });
  state.installedEditor = true;
}

function refreshUi(): void {
  state.activeTui?.requestRender();
}

class SkillToggleEditor extends CustomEditor {
  handleInput(data: string): void {
    if (handleToggleShortcut(data)) return;
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    lines[0] = renderToggleBorder(width, (text) => this.borderColor(text));
    return lines;
  }
}

interface CustomEditorHooks {
  actionHandlers: Map<AppKeybinding, () => void>;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
}

function hasCustomEditorHooks(editor: EditorComponent): editor is EditorComponent & CustomEditorHooks {
  return "actionHandlers" in editor && editor.actionHandlers instanceof Map;
}

class SkillToggleEditorWrapper implements EditorComponent, Focusable {
  private _focused = false;

  constructor(private readonly inner: EditorComponent) {}

  get borderColor(): ((str: string) => string) | undefined {
    return this.inner.borderColor?.bind(this.inner);
  }

  set borderColor(color: ((str: string) => string) | undefined) {
    this.inner.borderColor = color;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (isFocusable(this.inner)) this.inner.focused = value;
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.inner.wantsKeyRelease;
  }

  get actionHandlers(): Map<AppKeybinding, () => void> | undefined {
    return hasCustomEditorHooks(this.inner) ? this.inner.actionHandlers : undefined;
  }

  get onEscape(): (() => void) | undefined {
    return hasCustomEditorHooks(this.inner) ? this.inner.onEscape : undefined;
  }

  set onEscape(handler: (() => void) | undefined) {
    if (hasCustomEditorHooks(this.inner)) this.inner.onEscape = handler;
  }

  get onCtrlD(): (() => void) | undefined {
    return hasCustomEditorHooks(this.inner) ? this.inner.onCtrlD : undefined;
  }

  set onCtrlD(handler: (() => void) | undefined) {
    if (hasCustomEditorHooks(this.inner)) this.inner.onCtrlD = handler;
  }

  get onPasteImage(): (() => void) | undefined {
    return hasCustomEditorHooks(this.inner) ? this.inner.onPasteImage : undefined;
  }

  set onPasteImage(handler: (() => void) | undefined) {
    if (hasCustomEditorHooks(this.inner)) this.inner.onPasteImage = handler;
  }

  get onExtensionShortcut(): ((data: string) => boolean) | undefined {
    return hasCustomEditorHooks(this.inner) ? this.inner.onExtensionShortcut : undefined;
  }

  set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) {
    if (hasCustomEditorHooks(this.inner)) this.inner.onExtensionShortcut = handler;
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
    if (handleToggleShortcut(data)) return;
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
