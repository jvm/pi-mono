# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Root-level commands (`npm install`, `check`, `test`, `pack:dry-run`, `validate`) and the git/PR workflow are in AGENTS.md — follow that.

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
- `CLAUDE.md` files are only created by Claude Code, and never in package directories (see AGENTS.md). Other agents use `AGENTS.md`.

## Publishing

Publishing steps, release tag format, and the `/release-package` command are in AGENTS.md — follow that.
