# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

From the monorepo root:

```bash
npm install           # install all workspace deps
npm run check         # type-check all packages (tsc --noEmit)
npm test              # run all workspace tests
npm run pack:dry-run  # verify published package contents for all packages
npm run validate      # check + test + security:audit + pack:dry-run
```

Target a single workspace:

```bash
npm run check --workspace packages/pi-goal
npm test --workspace packages/pi-goal
npm run pack:dry-run --workspace packages/pi-web-kit
```

Run a single test file (from within the package directory or using tsx):

```bash
node --import tsx --test packages/pi-goal/tests/core.test.mjs
```

Local Pi testing without installing the package:

```bash
pi -e /path/to/pi-mono/packages/<package-name> --print "list your tools"
```

## Architecture

This is an npm workspaces monorepo of **Pi packages** — extensions for [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), a coding agent similar to Claude Code. Pi loads TypeScript source files directly at runtime via its built-in extension loader; **there is no build step and no `dist/` directory in any package**.

### Package layout

Every package follows the same structure:

```
packages/<name>/
  index.ts            # thin re-export: export { default } from "./extensions/index.js"
  extensions/index.ts # Pi extension wiring: registers tools, commands, event handlers
  src/                # business logic, kept separate from Pi API wiring
  src/install-telemetry.ts  # telemetry implementation (every publishable package)
  tests/              # node:test .test.mjs files (packages that have tests)
```

### Extension API pattern

Extensions default-export a function that receives a `pi: ExtensionAPI` instance:

```ts
export default function myExtension(pi: ExtensionAPI) {
  pi.registerTool({ name, parameters, execute, ... });
  pi.registerCommand("cmd", { handler });
  pi.on("session_start", async () => { ... });
  pi.on("before_agent_start", async (event) => ({ systemPrompt: ... }));
}
```

Pi resolves the extension entry point from `package.json → pi.extensions[0]`, which must point to the root `index.ts`. The root `index.ts` re-exports from `extensions/index.ts` so Pi displays the package name (not the path) in its loaded resources list.

### Install telemetry

Every publishable package implements `src/install-telemetry.ts` and calls `reportInstallTelemetry()` at the top of `extensions/index.ts`. Telemetry is fire-and-forget, opt-out, and deduplicates by version using a state file in Pi's extensions directory. It is disabled in CI environments, when `PI_OFFLINE` or `PI_TELEMETRY=false/0` is set, or when `settings.json → enableInstallTelemetry: false`. Use `pi-goal`'s `src/install-telemetry.ts` as the canonical reference implementation.

### Peer dependencies

Pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) are `peerDependencies` with `"*"` range and `devDependencies` with a pinned range (e.g. `"^0.75.4"`) for local type-checking. Keep pinned versions synchronized across all packages.

### Tests

Tests use `node:test` and `node:assert/strict` in `.test.mjs` files. Run via `node --import tsx --test tests/*.test.mjs`. Mock `globalThis.fetch` where needed and restore in `finally` blocks.

## Coding conventions

- ESM TypeScript, `"type": "module"`, `"target": "ES2022"`, `"module": "NodeNext"`.
- 2-space indentation, LF line endings, explicit `.js` import specifiers for local TypeScript modules (e.g. `import { foo } from "./foo.js"` resolves to `foo.ts` at runtime).
- New reusable logic belongs in `src/`; Pi API wiring belongs in `extensions/index.ts`; root `index.ts` stays a thin re-export.
- `CLAUDE.md` files are only created by Claude Code. Do not create them in package directories unless working in that package. Other agents use `AGENTS.md`.

## Publishing

Each package is published independently. The root is private and must not be published.

```bash
npm publish --workspace packages/<name>
```

Release tags follow the form `<package-name>@<version>` (e.g. `pi-web-kit@0.1.5`). When working in Pi, use the project-local `/release-package <name> <version>` command — it validates, tags, pushes, and creates the GitHub release.

Before publishing, verify package contents:

```bash
npm run pack:dry-run --workspace packages/<name>
```
