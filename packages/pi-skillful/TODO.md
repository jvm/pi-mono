# TODO: Session Skill Toggles

## Preparation

- [x] Review `PLAN.md` and current code paths for settings, skill visibility, inline skill invocation, and extension registration.
- [x] Review Pi editor/shortcut/system-prompt APIs and examples needed for implementation.

## Settings parsing (`src/config.ts`)

- [x] Add `SkillToggleSlot` type for slots `"1"` through `"9"`.
- [x] Add `SkillToggleModifier` type for supported shortcut modifier combinations.
- [x] Add `SkillToggleConfig` type.
- [x] Extend `SkillfulSettings` with `toggleSlots` and `toggleModifier` while preserving existing `hiddenSkills` compatibility.
- [x] Implement `normalizeToggleSlots(value)`:
  - [x] Accept only object values.
  - [x] Keep only slot keys `"1"` through `"9"`.
  - [x] Normalize skill names like hidden skills.
  - [x] Ignore empty skill names.
  - [x] Keep the lowest-numbered slot for duplicate skill names and ignore later duplicates.
- [x] Implement `normalizeToggleModifier(value)` with default `"alt"` and documented supported combinations.
- [x] Add `readEffectiveSkillfulSettings(cwd)` returning the union of global/project hidden skills plus effective toggle config.
- [x] Ensure write/update helpers preserve existing toggle settings when editing hidden skills.

## Shared skill prompt replacement

- [x] Create shared `src/skill-prompt.ts` module.
- [x] Move `SKILLS_SECTION_PATTERN` into the shared module.
- [x] Add a helper that replaces the `<available_skills>` section after formatting updated skills.
- [x] Refactor `src/extensions/skill-visibility.ts` to use the shared helper.
- [x] Keep existing hidden-skill menu/startup skill-list behavior intact.
- [x] Avoid independent prompt fighting by having session toggles become final source of truth when configured.

## Session toggle extension (`src/extensions/session-skill-toggles.ts`)

- [x] Create the new extension module.
- [x] Define in-memory session state for configured slots, active skill states, current modifier, and UI refresh hooks.
- [x] On `session_start`, read effective settings and loaded skill names.
- [x] Initialize configured slots in numeric order, ignoring unconfigured/unknown skills as needed.
- [x] Initialize each skill's active state from effective hidden visibility: visible skills active, hidden skills inactive.
- [x] Install/wrap the prompt editor when there are configured slots and UI is available.
- [x] Refresh the editor/widget state after initialization.
- [x] Register shortcuts for slots 1–9 using the configured modifier.
- [x] Shortcut handlers toggle assigned skills, update in-memory state, refresh UI, and no-op/notify for unassigned slots.
- [x] On `before_agent_start`, update `event.systemPromptOptions.skills` so inactive skills have `disableModelInvocation: true` and active skills are included.
- [x] Replace the skills section with the shared helper.
- [x] Preserve explicit inline `/skill:name` expansion independent of toggle state.
- [x] On `session_shutdown`, clear session-specific state and restore or clear editor customization if needed.

## Editor top-border rendering

- [x] Capture an existing editor factory with `ctx.ui.getEditorComponent()` before installing the toggle editor.
- [x] Compose with a previous editor factory when available.
- [x] Use `CustomEditor` default behavior when no previous editor is installed.
- [x] Replace/decorate only the first rendered line.
- [x] Render configured segments as exactly `N skill-name`, separated by two spaces.
- [x] Render active segments with `theme.fg("accent", text)`.
- [x] Render inactive segments with `theme.fg("muted", text)`.
- [x] Use `visibleWidth` and `truncateToWidth` to keep the line within the editor width.
- [x] Fill remaining top border with normal border glyph/color.
- [x] Keep a documented `setWidget("pi-skillful-session-toggles", ...)` fallback path if editor composition is unavailable.

## Extension wiring

- [x] Import `sessionSkillToggles` in `extensions/index.ts`.
- [x] Register session toggles after existing visibility logic so prompt replacement order is deterministic.

## Documentation

- [x] Update `README.md` with a “Session skill toggles” feature section.
- [x] Document JSON-only `toggleSlots` and `toggleModifier` configuration.
- [x] Mention default `alt+1` through `alt+9` shortcuts and session-only reset behavior.
- [x] Note that inline `/skill:name` remains explicit and independent of toggle state.
- [x] Update `CHANGELOG.md` with an unreleased entry.

## Validation

- [x] Run `npm run check`.
- [x] Run `npm run pack:dry-run`.
- [x] If practical, smoke-test in a temporary Pi project:
  - [x] Manual interactive smoke test was not practical in this non-interactive harness; validation was limited to TypeScript and package dry-run checks.
  - [x] Documented smoke-test coverage remains available in this checklist for a follow-up interactive Pi run.

## Completion

- [x] Ensure `TODO.md` accurately reflects completed work.
- [x] Review changed files for scope and formatting.
