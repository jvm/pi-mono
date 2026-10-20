# pi-goal Guidelines

Root `AGENTS.md` applies.

## Invariants

- Persist goal mutations as immutable branch entries; preserve tree/fork/reload reconstruction.
- Keep command names, entry/message shapes, tool schemas, and status transitions stable.
- `complete` needs requirement evidence; `blocked` needs repeated blocker evidence.
- Treat objectives as untrusted text when injecting continuation context.
- Automatic continuation must stop for pending user work, terminal states, budgets, and provider limits.
- Use palette-neutral Nerd Font footer icons with distinct shapes for every goal state; retain used/budget counts for every budgeted state.

## Validation

```bash
npm run -w packages/pi-goal check
npm test -w packages/pi-goal
npm run -w packages/pi-goal pack:dry-run
```

Test scheduler and lifecycle wiring for persistence or continuation changes.

## Development

Run a single test file:

```bash
node --import tsx --test tests/core.test.mjs
```

Local Pi testing (no install required): `pi -e /path/to/pi-mono/packages/pi-goal`.

## Architecture

Data flow: user `/goal` command or model goal tool → `extensions/index.ts` → `src/commands.ts` or `src/tools.ts` → goal mutation appended through `pi.appendEntry()` → state reconstructed from `ctx.sessionManager.getBranch()` → UI/status updates and optional hidden continuation context.

| Module | Role |
|---|---|
| `extensions/index.ts` | Extension entry point; registers `/goal`, model tools, renderers, lifecycle handlers, usage accounting, and continuation scheduling. |
| `src/state.ts` | Goal mutation creation/application and branch reconstruction. |
| `src/types.ts` | Shared types and the `GOAL_EVENT_TYPE` constant for custom session entries. |
| `src/accounting.ts` | Assistant usage-token accounting and budget checks. |
| `src/commands.ts` | `/goal` command parsing and command handlers. |
| `src/tools.ts` | `get_goal`, `create_goal`, and `update_goal` model tools. |
| `src/continuation.ts` | Hidden continuation scheduler and context-message filtering. |
| `src/prompts.ts` | Hidden continuation prompt construction. |
| `src/ui.ts` / `src/rendering.ts` | Footer/widget updates and custom message renderers. |
| `src/validation.ts` | Objective and token budget validation. |

## Conventions

- Persisted custom entry shapes and model tool schemas are public API; update docs and tests with any changes.
- JSON-encode or otherwise safely delimit goal objectives before putting them in model-visible continuation context.
