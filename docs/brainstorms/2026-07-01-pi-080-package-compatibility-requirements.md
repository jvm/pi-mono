# Pi 0.80 package compatibility requirements

## Outcome

Audit every workspace package for Pi 0.80 breakage and make the smallest PR-ready compatibility update.

## Pi 0.80 findings that matter here

- `@earendil-works/pi-ai` moved legacy root APIs such as `stream`, `completeSimple`, `getModel`, and provider registration to `@earendil-works/pi-ai/compat` (`CHANGELOG.md` in Pi 0.80.0). This repo does not use those APIs.
- `@earendil-works/pi-ai/base` and `@earendil-works/pi-agent-core/base` were removed. This repo does not import either entrypoint.
- Pi docs still document `StringEnum` from the `@earendil-works/pi-ai` root for extension schemas, so the existing `StringEnum` imports are valid.
- Core Pi packages imported by extensions should remain peer dependencies with `"*"` and be pinned in dev dependencies for local type-checking.

## Package audit

| Package | Pi surface | Result | Action |
| --- | --- | --- | --- |
| `pi-agentsmd` | `ExtensionAPI`, `ExtensionCommandContext`, `getAgentDir` | Affected only by stale Pi devDependency pin. | Update `@earendil-works/pi-coding-agent` devDependency to `^0.80.0`. |
| `pi-codex-image-gen` | `StringEnum`, `ExtensionAPI`, `getAgentDir`, `withFileMutationQueue` | Source APIs still compile on Pi 0.80; no legacy `pi-ai` APIs. | Update `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` devDependencies to `^0.80.0`. |
| `pi-compound-engineering` | `ExtensionAPI`, `ExtensionContext`, `SourceInfo`, commands | Source APIs still compile on Pi 0.80. | Update `@earendil-works/pi-coding-agent` devDependency to `^0.80.0`. |
| `pi-goal` | `StringEnum`, `Text`, lifecycle events, tools, commands | Source APIs still compile on Pi 0.80; `session_compact` usage remains valid. | Update `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` devDependencies to `^0.80.0`. |
| `pi-insomnia` | `ExtensionAPI`, lifecycle events, `getAgentDir` | Affected only by stale Pi devDependency pin. | Update `@earendil-works/pi-coding-agent` devDependency to `^0.80.0`. |
| `pi-scout` | `ExtensionAPI`, `ExtensionCommandContext`, `getAgentDir` | Affected only by stale Pi devDependency pin. | Update `@earendil-works/pi-coding-agent` devDependency to `^0.80.0`. |
| `pi-skillful` | `CustomEditor`, `formatSkillsForPrompt`, `SourceInfo`, `SettingsList` | Already updated to Pi `^0.80.0`; no source fix needed. | No change. |
| `pi-web-kit` | `ExtensionAPI`, `getAgentDir`, `Text` | Source APIs still compile on Pi 0.80. | Update `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` devDependencies to `^0.80.0`. |

## Acceptance criteria

- All workspace Pi core devDependency pins are synchronized on `^0.80.0`.
- Root `package-lock.json` resolves Pi core packages to a current 0.80.x release.
- No source import is left using removed Pi 0.80 entrypoints.
- `npm run check`, `npm test`, and `npm ci --dry-run` pass.
