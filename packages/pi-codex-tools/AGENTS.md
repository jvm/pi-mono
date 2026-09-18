# pi-codex-tools Guidelines

Root `AGENTS.md` applies.

## Invariants

- Keep `apply_patch` a raw OpenAI custom tool: use the Codex Lark grammar and never ask the model to JSON-wrap the patch.
- Activate `apply_patch` only when the current model uses `openai-codex-responses` or `openai-responses` and explicitly advertises `compat.supportsOpenAIGrammarTools`.
- Preserve unrelated active tools when switching models; only manage the Pi `edit` and `write` tools and this package's `apply_patch` tool.
- Resolve relative patch paths from the current working directory and accept absolute paths. Follow symlinks for reads/writes like Pi's native file tools; delete/move removes the source directory entry, not a symlink's referent. Use Node filesystem APIs without a native binding or platform gate. This is not a sandbox.
- Preflight every hunk against shared virtual content for symlink aliases. Canonicalize and deduplicate queue keys before nesting `withFileMutationQueue` locks; keep locks held until all I/O settles.
- Do not add Codex's shell/session or code-mode tools without a separate sandbox/approval design; Pi already provides shell, read, and write tools.
- Preserve OpenAI Codex attribution in `NOTICE` and the Apache-2.0 license for adapted grammar/parser behavior.

## Validation

```bash
npm run -w packages/pi-codex-tools check
npm test -w packages/pi-codex-tools
npm run -w packages/pi-codex-tools pack:dry-run
```
