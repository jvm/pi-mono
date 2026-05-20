# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps
npm run check        # type-check (tsc --noEmit) — the only lint/verify step
npm run pack:dry-run # preview what would be published
```

There is no build step and no test suite. Pi loads TypeScript extensions directly via its built-in extension loader.

## Release workflow

1. Update `CHANGELOG.md` — move items from `[Unreleased]` into a new `[X.Y.Z] - YYYY-MM-DD` section.
2. Bump `version` in `package.json`.
3. Commit and push to `main`.
4. Publish from the monorepo workspace after validation:
   `npm publish --workspace packages/pi-skillful --access public`.
5. If release automation is added later, keep it rooted in `jvm/pi-mono` and scoped to this workspace.

## Architecture

`pi-skillful` is a [Pi](https://pi.dev) package. Pi packages are source-distributed TypeScript that Pi loads at runtime without compilation.

**Entry point**: `extensions/index.ts` — the file Pi resolves from the `pi.extensions` array in `package.json`. It imports and registers both features against the `ExtensionAPI`.

**Shared modules** live in `src/`:

- `src/config.ts` — reads and writes the `skillful.hiddenSkills` list from Pi's settings files (`~/.pi/agent/settings.json` for global, `.pi/settings.json` for project). Effective hidden skills are the union of both scopes. When the project scope's `hiddenSkills` becomes empty, the project settings file is deleted entirely.
- `src/skills.ts` — utilities for extracting `SkillCommandInfo` from Pi commands and reading a skill's `SKILL.md` into a `<skill>` XML block (with frontmatter stripped).
- `src/extensions/inline-skill-invocation.ts` — hooks `pi.on("input")` to expand `/skill:name` markers anywhere in the prompt (not just at the start). Replaces each known marker with the skill's `SKILL.md` content before Pi's own expansion runs.
- `src/extensions/skill-visibility.ts` — hooks `pi.on("before_agent_start")` to remove hidden skills from the `<available_skills>` system prompt section by re-running `formatSkillsForPrompt` with `disableModelInvocation: true` on hidden entries. Also registers the `/skillful` command, which opens a TUI menu (`SkillfulVisibilityMenu`) backed by `SettingsList` from `@earendil-works/pi-tui`. The startup `[Skills]` list is colorized by monkey-patching `InteractiveMode.prototype.showLoadedResources` — the patch intercepts the `ExpandableText` for `[Skills]` and replaces its `getCollapsedText` with a closure that reads `store.lastHiddenSkills` lazily, coloring visible skills dim and hidden skills in the error color. The patch uses `Symbol.for("pi-skillful.startupPatchV2")` on the prototype to guard against double-patching across hot reloads; the singleton store is keyed at `Symbol.for("pi-skillful.skillVisibilityStore")` on `globalThis`.

**Peer dependencies**: `@earendil-works/pi-coding-agent` (provides `ExtensionAPI`, `InteractiveMode`, `formatSkillsForPrompt`, `Skill`, `Theme`, etc.) and `@earendil-works/pi-tui` (provides `TUI`, `Component`, `SettingsList`, `DynamicBorder`, `Key`, etc.). Both are also listed as `devDependencies` for type-checking.
