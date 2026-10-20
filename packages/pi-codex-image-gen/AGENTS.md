# pi-codex-image-gen Guidelines

Root `AGENTS.md` applies.

## Invariants

- Keep both generation entry points, output schemas, skill guidance, config, and tests synchronized. Inline delivery stays model-only; scripted delivery returns original artifact paths, never base64.
- Retain completed private originals across cancellation of later script work, reload, and branch changes. Clean only this call's incomplete reservations; never overwrite files or retry generation to repair storage errors. Recovery metadata follows the current branch.
- Own image OAuth under `codex-images`; let Pi store and refresh credentials. Preserve legacy Pi `openai-codex` fallback only when owned credentials are absent. Never use the `openai` plan-sharing chat token, Codex app credentials, API-key billing, or log tokens/auth headers.
- Keep the OAuth implementation independent of Pi's legacy OAuth helpers. Validate PKCE/state, honor cancellation, bound token responses, and do not switch accounts after an auth failure.
- Treat `skills/imagegen/scripts/image_gen.py` as vendored; preserve attribution and avoid casual edits.
- Preserve save modes and config keys unless making an explicit breaking change.

## Validation

```bash
npm run -w packages/pi-codex-image-gen check
npm test -w packages/pi-codex-image-gen
npm run -w packages/pi-codex-image-gen pack:dry-run
```

Smoke test extension loading and Python helpers after relevant changes; use `uv` for Python dependencies.

## Development

There is no build step. Dry-run the CLI fallback without an API key:

```bash
python skills/imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/test.png --dry-run
```

## Architecture

The package bundles two Pi artifacts exposed via `package.json → pi`:

1. **Extension** (`extensions/codex-image-gen.ts`): registers a `codex_generate_image` tool. Auth piggybacks on Pi's existing `openai-codex` login; `OPENAI_API_KEY` is not required.
2. **Skill** (`skills/imagegen/`): prompting playbook that tells Pi when and how to call the tool, with a Python CLI fallback for cases the tool cannot cover.

Extension flow (`extensions/codex-image-gen.ts`, a single file by design):

1. Load merged config: `~/.pi/agent/extensions/codex-image-gen.json` (global) overlaid with `<cwd>/.pi/extensions/codex-image-gen.json` (project).
2. Resolve model: `params.model` → config → `gpt-5.5` default → `gpt-5.3-codex` fallback via `modelRegistry.find("openai-codex", ...)`.
3. Pull the Codex JWT via `ctx.modelRegistry.getApiKeyForProvider("openai-codex")`, decode the `https://api.openai.com/auth` claim, extract `chatgpt_account_id`.
4. POST a streamed Responses request to `https://chatgpt.com/backend-api/codex/responses` with `tools: [{ type: "image_generation" }]` and `OpenAI-Beta: responses=experimental`.
5. Parse the SSE stream; the image arrives in the `response.output_item.done` event of type `image_generation_call` (base64 `result`).
6. Save to disk unless `save=none`; return a text summary and an image content block.

Save-mode precedence (`resolveSaveConfig`): `params.save` → `PI_CODEX_IMAGE_SAVE_MODE` env → config file → `"global"`. Modes: `none`, `project` (`<cwd>/.pi/generated-images/<sessionId>/`), `global` (`<agentDir>/generated-images/<sessionId>/`), `custom` (requires `params.saveDir` or `PI_CODEX_IMAGE_SAVE_DIR`). Filenames use the Codex `image_generation_call` ID, sanitized to `[a-zA-Z0-9_-]`. Disk writes go through `withFileMutationQueue` to serialize concurrent saves.

Skill invariants (`skills/imagegen/SKILL.md`):

- Two top-level modes only: Pi tool mode (default) and CLI fallback. "Batch" alone does not opt into CLI mode; issue one tool call per asset.
- Transparent images: generate on a chroma-key background, then `scripts/remove_chroma_key.py` converts to alpha. Escalate to CLI `gpt-image-1.5 --background transparent` only after explicit user confirmation, because `gpt-image-2` does not support `background=transparent`.
- `references/` files (`cli.md`, `image-api.md`, `codex-network.md`) are CLI-fallback-only; load them only when relevant.

## Editing guidance

- When changing tool parameters, update the `TOOL_PARAMS` Typebox schema and the `promptGuidelines` strings. Pi surfaces both to the model.
- The Codex SSE contract (`response.output_item.done` with `image_generation_call`) is undocumented and may shift. Log raw SSE events before assuming a code bug if generation breaks.
- Save-mode defaults and config-file shape are user-visible; changing them breaks users with an existing `codex-image-gen.json`.
