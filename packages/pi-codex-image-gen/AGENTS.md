# pi-codex-image-gen Guidelines

Root `AGENTS.md` applies.

## Invariants

- Keep `codex_generate_image` schema, skill guidance, config, and tests synchronized.
- Normal use reuses `openai-codex` auth; never log tokens or auth headers.
- Treat `skills/imagegen/scripts/image_gen.py` as vendored; preserve attribution and avoid casual edits.
- Preserve save modes and config keys unless making an explicit breaking change.

## Validation

```bash
npm run -w packages/pi-codex-image-gen check
npm test -w packages/pi-codex-image-gen
npm run -w packages/pi-codex-image-gen pack:dry-run
```

Smoke test extension loading and Python helpers after relevant changes; use `uv` for Python dependencies.
