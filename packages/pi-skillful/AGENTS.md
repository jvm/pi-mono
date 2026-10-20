# pi-skillful Guidelines

Root `AGENTS.md` applies.

## Invariants

- Hidden skills remain explicitly invokable.
- Package-bundled skills are never hidden or assigned toggle slots.
- Project settings require active trust; global inheritance remains intact.
- Compose editor wrappers with focus, IME, hooks, and previous editor behavior.
- Startup coloring uses private Pi UI API: isolate it and keep integration coverage that fails if patch wiring disappears.

## Validation

```bash
npm run -w packages/pi-skillful check
npm test -w packages/pi-skillful
npm run -w packages/pi-skillful pack:dry-run
```

Smoke test `/skillful`, startup colors, hidden invocation, inline invocation, and configured shortcuts after UI changes.

For startup-renderer changes, use a disposable Pi profile with one hidden and one visible skill. Check the collapsed `[Skills]` colors in regular and fullscreen modes, expand/collapse the resource list, change themes, and run `/reload`. Expanded paths must remain native; collapsed colors must follow the current theme and settings without duplicating sections.

## Architecture

Three features are wired in `extensions/index.ts`. There is no build step and no test suite; `check` is the only verify step.

1. **Inline skill invocation** (`src/extensions/inline-skill-invocation.ts`): hooks `pi.on("input")` to expand `/skill:name` markers anywhere in the prompt, not just at the start. Replaces each known marker with the skill's `SKILL.md` content before Pi's own expansion runs.
2. **Skill visibility** (`src/extensions/skill-visibility.ts`): hooks `pi.on("before_agent_start")` to remove hidden skills from the `<available_skills>` system prompt section by re-running `formatSkillsForPrompt` with `disableModelInvocation: true` on hidden entries. Also registers the `/skillful` command, which opens a TUI menu backed by `SettingsList`.
   The startup `[Skills]` list is colorized by monkey-patching `InteractiveMode.prototype.showLoadedResources`. The patch intercepts the `ExpandableText` for `[Skills]` and replaces its `getCollapsedText` with a closure that reads `store.lastHiddenSkills` lazily. It uses `Symbol.for("pi-skillful.startupPatchV2")` on the prototype to guard against double-patching across hot reloads; the singleton store is keyed at `Symbol.for("pi-skillful.skillVisibilityStore")` on `globalThis`.
3. **Session skill toggles** (`src/extensions/session-skill-toggles.ts`): assigns skills to configurable keyboard shortcut slots (for example Alt+1, Alt+2) through `skillful.toggleSlots` in Pi settings. Renders active/inactive state in a custom editor border or fallback widget. Hooks `before_agent_start` to mark toggled-off skills as `disableModelInvocation: true` using `replaceSkillsSection` from `src/skill-prompt.ts`. Slot active-state is preserved across `session_start` events with reason `"new"` in the same cwd.

| Module | Role |
|---|---|
| `src/config.ts` | Reads/writes `skillful.hiddenSkills` and `skillful.toggleSlots` from Pi's global and project settings files. Effective hidden skills are the union of both scopes. |
| `src/skills.ts` | Extracts `SkillCommandInfo` from Pi commands; reads a skill's `SKILL.md` into a `<skill>` XML block with frontmatter stripped. |
| `src/skill-prompt.ts` | `replaceSkillsSection`: swaps the `<available_skills>` block in a system prompt using `formatSkillsForPrompt`. |
