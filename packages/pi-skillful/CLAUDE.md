# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run check        # type-check (tsc --noEmit) — the only verify step
npm run pack:dry-run # preview what would be published
```

There is no build step and no test suite.

## Architecture

`pi-skillful` is a Pi package with three features wired in `extensions/index.ts`:

### 1. Inline skill invocation (`src/extensions/inline-skill-invocation.ts`)

Hooks `pi.on("input")` to expand `/skill:name` markers anywhere in the prompt (not just at the start). Replaces each known marker with the skill's `SKILL.md` content before Pi's own expansion runs.

### 2. Skill visibility (`src/extensions/skill-visibility.ts`)

Hooks `pi.on("before_agent_start")` to remove hidden skills from the `<available_skills>` system prompt section by re-running `formatSkillsForPrompt` with `disableModelInvocation: true` on hidden entries. Also registers the `/skillful` command, which opens a TUI menu backed by `SettingsList`.

The startup `[Skills]` list is colorized by monkey-patching `InteractiveMode.prototype.showLoadedResources` — the patch intercepts the `ExpandableText` for `[Skills]` and replaces its `getCollapsedText` with a closure that reads `store.lastHiddenSkills` lazily. The patch uses `Symbol.for("pi-skillful.startupPatchV2")` on the prototype to guard against double-patching across hot reloads; the singleton store is keyed at `Symbol.for("pi-skillful.skillVisibilityStore")` on `globalThis`.

### 3. Session skill toggles (`src/extensions/session-skill-toggles.ts`)

Assigns skills to configurable keyboard shortcut slots (e.g. Alt+1, Alt+2). Configured via `skillful.toggleSlots` in Pi settings. Renders active/inactive state in a custom editor border or fallback widget. Hooks `before_agent_start` to mark toggled-off skills as `disableModelInvocation: true` using `replaceSkillsSection` from `src/skill-prompt.ts`. Slot active-state is preserved across `session_start` events with reason `"new"` in the same cwd.

### Shared modules

| Module | Role |
|---|---|
| `src/config.ts` | Reads/writes `skillful.hiddenSkills` and `skillful.toggleSlots` from Pi's global and project settings files. Effective hidden skills are the union of both scopes. |
| `src/skills.ts` | Extracts `SkillCommandInfo` from Pi commands; reads a skill's `SKILL.md` into a `<skill>` XML block with frontmatter stripped. |
| `src/skill-prompt.ts` | `replaceSkillsSection` — swaps the `<available_skills>` block in a system prompt using `formatSkillsForPrompt`. |
