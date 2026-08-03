# pi-codex-tools Guidelines

Root `AGENTS.md` applies.

## Invariants

- Keep `apply_patch` a raw OpenAI custom tool: use the Codex Lark grammar and never ask the model to JSON-wrap the patch.
- Activate `apply_patch` only when the current model uses `openai-codex-responses` or `openai-responses` and explicitly advertises `compat.supportsOpenAIGrammarTools`.
- Preserve unrelated active tools when switching models; only manage the Pi `edit` and `write` tools and this package's `apply_patch` tool.
- Resolve patch paths under the current working directory, reject symlink escapes, use root-anchored descriptor-based no-follow operations on Linux/macOS, fail closed elsewhere, serialize mutations through `withFileMutationQueue`, and preflight every hunk before writing.
- Do not add Codex's shell/session or code-mode tools without a separate sandbox/approval design; Pi already provides shell, read, and write tools.
- Preserve OpenAI Codex attribution in `NOTICE` and the Apache-2.0 license for adapted grammar/parser behavior.

## Validation

```bash
npm run -w packages/pi-codex-tools check
npm test -w packages/pi-codex-tools
npm run -w packages/pi-codex-tools pack:dry-run
```
