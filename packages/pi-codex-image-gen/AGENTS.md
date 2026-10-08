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
