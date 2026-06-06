# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run check        # type-check the extension
npm run pack:dry-run # preview what would be published
```

There is no build step and no test suite. Dry-run the CLI fallback without an API key:

```bash
python skills/imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/test.png --dry-run
```

## Architecture

This package bundles two Pi artifacts exposed via `package.json → pi`:

1. **Extension** (`extensions/codex-image-gen.ts`) — registers a `codex_generate_image` tool. Auth piggybacks on Pi's existing `openai-codex` login; `OPENAI_API_KEY` is not required.
2. **Skill** (`skills/imagegen/`) — prompting playbook that tells Pi when and how to call the tool, with a Python CLI fallback for cases the tool can't cover.

### Extension flow (`extensions/codex-image-gen.ts`)

The extension is a single file by design. Tool execution:

1. Load merged config: `~/.pi/agent/extensions/codex-image-gen.json` (global) overlaid with `<cwd>/.pi/extensions/codex-image-gen.json` (project).
2. Resolve model: `params.model` → config → `gpt-5.5` default → `gpt-5.3-codex` fallback via `modelRegistry.find("openai-codex", ...)`.
3. Pull the Codex JWT via `ctx.modelRegistry.getApiKeyForProvider("openai-codex")`, decode the `https://api.openai.com/auth` claim, extract `chatgpt_account_id`.
4. POST a streamed Responses request to `https://chatgpt.com/backend-api/codex/responses` with `tools: [{ type: "image_generation" }]` and `OpenAI-Beta: responses=experimental`.
5. Parse SSE stream; image arrives in `response.output_item.done` event of type `image_generation_call` (base64-encoded `result`).
6. Save to disk unless `save=none`; return text summary + image content block.

**Save-mode precedence** (`resolveSaveConfig`): `params.save` → `PI_CODEX_IMAGE_SAVE_MODE` env → config file → `"global"`. Modes: `none`, `project` (`<cwd>/.pi/generated-images/<sessionId>/`), `global` (`<agentDir>/generated-images/<sessionId>/`), `custom` (requires `params.saveDir` or `PI_CODEX_IMAGE_SAVE_DIR`). Filenames use the Codex `image_generation_call` ID, sanitized to `[a-zA-Z0-9_-]`. Disk writes go through `withFileMutationQueue` to serialize concurrent saves.

### Skill invariants (`skills/imagegen/SKILL.md`)

- **Two top-level modes only**: Pi tool mode (default) and CLI fallback. "Batch" alone does not opt into CLI mode — issue one tool call per asset.
- **Transparent images**: generate on a chroma-key background, then `scripts/remove_chroma_key.py` converts to alpha. Only escalate to CLI `gpt-image-1.5 --background transparent` after explicit user confirmation, because `gpt-image-2` does not support `background=transparent`.
- **Never modify `scripts/image_gen.py`** — it is vendored. Ask first if something is missing.
- `references/` files (`cli.md`, `image-api.md`, `codex-network.md`) are CLI-fallback-only; load only when relevant.

## Editing guidance

- When changing tool parameters, update the `TOOL_PARAMS` Typebox schema **and** the `promptGuidelines` strings — Pi surfaces both to the model.
- The Codex SSE contract (`response.output_item.done` with `image_generation_call`) is undocumented and may shift; log raw SSE events before assuming a code bug if generation breaks.
- Save-mode defaults and config-file shape are user-visible — changing them is a breaking change for users with existing `codex-image-gen.json`.
