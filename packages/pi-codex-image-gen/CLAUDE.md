# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **pi-package** (consumed by [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) that bundles two artifacts:

1. **A Pi extension** (`extensions/codex-image-gen.ts`) — registers a `codex_generate_image` tool that generates bitmap images via the OpenAI Codex (ChatGPT) backend using `gpt-image-2`. Auth piggybacks on Pi's existing `openai-codex` login, so `OPENAI_API_KEY` is **not** required for the default path.
2. **A Pi skill** (`skills/imagegen/`) — a workflow/prompting playbook that tells Pi when and how to call the tool, with a Python CLI fallback (`scripts/image_gen.py`) for cases the tool can't cover (notably true-native transparency via `gpt-image-1.5`).

Both are exposed via the `pi` field in `package.json`:

```json
"pi": { "extensions": ["./extensions"], "skills": ["./skills"] }
```

There is no build, lint, or test pipeline in this repo. Peer deps (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) are resolved by the host Pi installation at runtime.

## Architecture

### Extension (`extensions/codex-image-gen.ts`)

Default-exports a function that calls `pi.registerTool(...)`. The tool flow:

1. Load merged config from `~/.pi/agent/extensions/codex-image-gen.json` (global) overlaid with `<cwd>/.pi/extensions/codex-image-gen.json` (project).
2. Resolve the model: `params.model` → config → `gpt-5.5` (default) → `gpt-5.3-codex` (fallback). Pi's `modelRegistry.find("openai-codex", ...)` normalizes IDs.
3. Pull the Codex JWT via `ctx.modelRegistry.getApiKeyForProvider("openai-codex")`, decode the `https://api.openai.com/auth` claim, and extract `chatgpt_account_id`.
4. POST a streamed Responses request to `https://chatgpt.com/backend-api/codex/responses` with `tools: [{ type: "image_generation", output_format }]` and `OpenAI-Beta: responses=experimental`.
5. Parse the SSE stream; the image arrives in a `response.output_item.done` event of type `image_generation_call` (base64-encoded `result`).
6. Save under the directory chosen by save-mode resolution (see below), unless `save=none`. Returns both a text summary and an `image` content block.

**Save-mode precedence** (`resolveSaveConfig`): `params.save` → `PI_CODEX_IMAGE_SAVE_MODE` env → config file → `"global"`. Modes:
- `none` — no disk write.
- `project` — `<cwd>/.pi/generated-images/<sessionId>/...`.
- `global` (default) — `<getAgentDir()>/generated-images/<sessionId>/...`.
- `custom` — requires `params.saveDir` or `PI_CODEX_IMAGE_SAVE_DIR`.

Filenames use the Codex `image_generation_call` ID, sanitized via `sanitizePathPart` (only `[a-zA-Z0-9_-]` survives). Disk writes go through `withFileMutationQueue` from pi-coding-agent to serialize concurrent saves.

### Skill (`skills/imagegen/`)

`SKILL.md` is the spec the agent reads. Key invariants:

- **Two top-level modes only**: Pi tool mode (default) and CLI fallback mode. The word "batch" alone does not opt into CLI mode — issue one Pi tool call per asset instead.
- **Transparent images**: Pi tool path generates on a chroma-key background, then `scripts/remove_chroma_key.py` converts the key color to alpha. Only escalate to CLI `gpt-image-1.5 --background transparent` after explicit user confirmation, because `gpt-image-2` does not support `background=transparent`.
- **Never modify `scripts/image_gen.py`** — it is a vendored fallback. If something is missing, ask first.
- Project-bound assets must be moved/copied into the workspace; do not leave them only at the default `<pi-agent-dir>/generated-images/<sessionId>/...` path.

`references/` files (`prompting.md`, `sample-prompts.md`, `cli.md`, `image-api.md`, `codex-network.md`) are loaded only when relevant — `cli.md`/`image-api.md`/`codex-network.md` are CLI-fallback-only.

### CLI fallback (`skills/imagegen/scripts/image_gen.py`)

Standalone Python CLI with three subcommands: `generate`, `edit`, `generate-batch`. Defaults to `gpt-image-2`. Requires `OPENAI_API_KEY` + network access for live calls; `--dry-run` works without either. Per the global agent rules, install deps via `uv pip install openai pillow`.

## Common tasks

There is no `npm test` / linter wired up. Useful manual checks:

- **Type-check the extension**:
  ```bash
  npm run check
  ```
  This requires `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` resolvable from `node_modules` (install them locally with `npm install` if iterating in isolation).

- **Dry-run the CLI fallback** (no API key needed):
  ```bash
  python skills/imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/test.png --dry-run
  ```

- **Smoke-test the Pi tool**: install this package into a Pi-managed workspace (e.g. `pi package add <path>`), run `/login` for `openai-codex`, then ask Pi to generate an image.

## Editing guidance specific to this repo

- The extension is a single file by design — keep new helpers in `extensions/codex-image-gen.ts` unless there's a clear reason to split.
- When changing tool parameters, update the `TOOL_PARAMS` Typebox schema **and** the `promptGuidelines` strings; Pi surfaces both to the model.
- The Codex Responses contract (`response.output_item.done` with `image_generation_call`) is undocumented and may shift; if generation breaks, log raw SSE events first before assuming a code bug.
- Save-mode and config-file shape are user-visible — changing defaults or precedence is a breaking change for anyone with an existing `codex-image-gen.json`.
- The skill's transparent-image rules (chroma-key first, ask before `gpt-image-1.5`) are deliberate; do not "simplify" them by auto-routing to the CLI.
