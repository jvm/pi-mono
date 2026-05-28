# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this package.

## Commands

```bash
npm install          # install deps from the monorepo root
npm run check        # type-check (tsc --noEmit)
npm test             # run all workspace tests
npm run pack:dry-run # verify published package contents
```

Run only this package:

```bash
npm run check --workspace packages/pi-goal
npm test --workspace packages/pi-goal
npm run pack:dry-run --workspace packages/pi-goal
```

Run a single test file from the package directory:

```bash
node --import tsx --test tests/core.test.mjs
```

Local Pi testing (no install required):

```bash
pi -e /path/to/pi-mono/packages/pi-goal
```

## Architecture

`pi-goal` is a source-distributed Pi agent extension (no build step). Pi loads TypeScript directly; there is no `dist/`.

### Data flow

User `/goal` command or model goal tool → `extensions/index.ts` → `src/commands.ts` or `src/tools.ts` → goal mutation appended through `pi.appendEntry()` → state reconstructed from `ctx.sessionManager.getBranch()` → UI/status updates and optional hidden continuation context.

### Key modules

| Module | Role |
|---|---|
| `extensions/index.ts` | Extension entry point; registers `/goal`, model tools, renderers, lifecycle handlers, usage accounting, and continuation scheduling. |
| `src/state.ts` | Goal mutation creation/application and branch reconstruction. |
| `src/accounting.ts` | Assistant usage-token accounting and budget checks. |
| `src/commands.ts` | `/goal` command parsing and command handlers. |
| `src/tools.ts` | `get_goal`, `create_goal`, and `update_goal` model tools. |
| `src/continuation.ts` | Hidden continuation scheduler and context-message filtering. |
| `src/prompts.ts` | Hidden continuation prompt construction. |
| `src/ui.ts` / `src/rendering.ts` | Footer/widget updates and custom message renderers. |
| `src/validation.ts` | Objective and token budget validation. |

## Coding conventions

- ESM TypeScript, 2-space indent, explicit `.js` import specifiers for local modules.
- Tests use `node:test` and `node:assert/strict` in `.test.mjs` files.
- New reusable logic belongs in `src/`; Pi wiring belongs in `extensions/index.ts`.
- Persisted custom entry shapes and model tool schemas are public API; update docs and tests with any changes.
- Goal objectives are untrusted user text. JSON-encode or otherwise safely delimit objectives before putting them in model-visible continuation context.
