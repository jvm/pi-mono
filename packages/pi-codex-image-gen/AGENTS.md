# Repository Guidelines

## Project Structure & Module Organization

This is a Pi package exposing one extension and one skill via `package.json`.

- `index.ts`: TypeScript Pi extension that registers the `codex_generate_image` tool.
- `skills/imagegen/SKILL.md`: agent-facing image generation workflow.
- `skills/imagegen/scripts/`: Python helpers, including vendored `image_gen.py` and chroma-key removal.
- `skills/imagegen/references/`: supporting docs loaded only when relevant.
- `skills/imagegen/assets/`: skill images and static assets.

There is no dedicated `tests/` or build output directory.

## Build, Test, and Development Commands

Run these in order after any extension or skill change. All must pass before committing.

### 1. Install dependencies (first time or after package.json changes)

```bash
npm install
```

Installs `typescript`, `@types/node`, and resolves Pi peer dependencies (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) into `node_modules/`. The `package-lock.json` file must be committed.

### 2. Type-check

```bash
npm run check
```

Uses `tsconfig.json` (ES2022 / NodeNext module resolution). Catches schema mismatches, missing imports, and type errors in the extension.

### 3. Extension load smoke test

```bash
pi -p --no-session -ne -e . 'list your tools'
```

Validates that the extension loads without errors, the `codex_generate_image` tool registers correctly, and the Typebox `TOOL_PARAMS` schema is valid. The tool should appear in the output. This exercises the full jiti loading path that Pi uses at runtime.

- `-p` — print mode, exits after processing.
- `--no-session` — ephemeral, no session file created.
- `-ne` — skip global extension discovery to avoid noise.
- `-e .` — load this package as an extension source (Pi reads the `pi` manifest from `package.json`).

### 4. Python helper validation

```bash
python3 skills/imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/test.png --dry-run
python3 skills/imagegen/scripts/remove_chroma_key.py --help
```

First command validates CLI argument parsing and config resolution without an API key or network call (`--dry-run`). Second confirms the chroma-key removal script is importable and its argparse is intact.

### Full loop (copy-paste)

```bash
npm run check &&
  pi -p --no-session -ne -e . 'list your tools' &&
  python3 skills/imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/test.png --dry-run
```

No `npm test`, formatter, or linter script is wired in `package.json`.

## Coding Style & Naming Conventions

Use TypeScript ESM for extensions and keep helper logic in `index.ts` unless a split clearly reduces complexity. Follow the existing style: 2-space indentation, `const` for constants, PascalCase for interfaces/types, camelCase for functions and variables, and UPPER_SNAKE_CASE for module constants.

When changing tool parameters, update both the Typebox `TOOL_PARAMS` schema and prompt guidance. Preserve save-mode names and config keys unless intentionally making a breaking change.

## Testing Guidelines

There is no formal test framework yet. The development loop above covers:

1. **Type safety** — `tsc --noEmit` catches compile-time errors.
2. **Runtime loading** — `pi -e .` confirms the extension factory runs, the tool registers, and the schema is valid.
3. **Python fallbacks** — `--dry-run` confirms CLI argument handling.

For manual integration testing, start an interactive session with `pi -e .` and ask the agent to generate an image. For Python helpers, prefer project-local `uv` environments when dependencies are needed.

Do not modify `skills/imagegen/scripts/image_gen.py` casually; it is treated as a vendored fallback. If behavior must change, document why in the pull request.

## Commit & Pull Request Guidelines

The current history only shows initial commits, so use short imperative messages such as `Add image save config` or `Fix SSE parsing`. Keep commits focused by artifact: extension behavior, skill guidance, or helper scripts.

Pull requests should include a concise summary, verification commands, Pi smoke-test notes, and screenshots or generated image paths when visual behavior changes. Link issues when available and call out breaking changes to config, save modes, tool parameters, or auth assumptions.

## Security & Configuration Tips

The default extension path uses Pi `openai-codex` auth; do not require `OPENAI_API_KEY` for normal tool use. Avoid logging tokens, decoded JWT payloads, or raw auth headers. Config loads from global and project `.pi` locations, so treat shape and precedence as public interface.
