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

The root entry re-exports `extensions/index.ts`. It registers model-only inline
generation, typed artifact generation, and read-only artifact listing.
`src/image-oauth.ts` owns the `codex-images` OAuth provider, with legacy
`openai-codex` fallback only when owned credentials are absent.
`src/codex-response.ts` bounds/parses private backend responses;
`src/artifacts.ts` owns private originals and branch-local recovery manifests;
`src/admission.ts` bounds shared account generation admission.

Generation snapshots arguments, loads trusted config, resolves OAuth, waits for
account admission, loads reference bytes, reserves artifact storage, then sends the
Responses request. The routing default is `gpt-6-astra`, not an image-model
selector. Inline results include an image; artifact results return original
paths without bytes. Listing performs no generation.

Save-mode precedence (`resolveSaveConfig`): `params.save` → `PI_CODEX_IMAGE_SAVE_MODE` env → config file → `"global"`. Modes: `none`, `project` (`<cwd>/.pi/generated-images/<sessionId>/`), `global` (`<agentDir>/generated-images/<sessionId>/`), `custom` (requires `params.saveDir` or `PI_CODEX_IMAGE_SAVE_DIR`). Filenames use the Codex `image_generation_call` ID, sanitized to `[a-zA-Z0-9_-]`. Disk writes go through `withFileMutationQueue` to serialize concurrent saves.

Skill invariants (`skills/imagegen/SKILL.md`):

- Two top-level modes only: Pi tool mode (default) and CLI fallback. "Batch" alone does not opt into CLI mode; issue one tool call per asset.
- Transparent images: use chroma-key removal first; native-transparency CLI fallback requires explicit confirmation and separate API billing. Follow the skill's current model guidance.
- `references/` files (`cli.md`, `image-api.md`, `codex-network.md`) are CLI-fallback-only; load them only when relevant.

## Editing guidance

- When changing tool parameters, update the `TOOL_PARAMS` Typebox schema and the `promptGuidelines` strings. Pi surfaces both to the model.
- The Codex SSE contract is private and may shift. Use synthetic fixtures and sanitized diagnostics; never log raw SSE image payloads or credentials.
- Save-mode defaults and config-file shape are user-visible; changing them breaks users with an existing `codex-image-gen.json`.
