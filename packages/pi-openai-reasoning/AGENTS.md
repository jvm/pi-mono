# pi-openai-reasoning Guidelines

Root `AGENTS.md` applies.

## Invariants

- Enable only Codex OAuth model/mode pairs verified against the live backend.
- Use Pi's existing thinking controls; do not register a replacement provider.
- Keep the request effort fixed within a context window and replay updates at
  checked history boundaries. Never emit adjacent updates.
- Persist only bounded effort metadata and SHA-256 history fingerprints in
  branch-local custom entries. Do not store prompts or credentials.
- Standard compaction must not mutate live reasoning state while summarizing.
  A successful compaction starts a new window. Do not restore the removed
  direct-compaction event-bus adapter.
- Leave unsupported providers, Pro/multi-agent modes and auto-truncated requests
  unchanged. Never fall back to a public API key.

## Validation

```bash
npm run -w packages/pi-openai-reasoning check
npm test -w packages/pi-openai-reasoning
npm run -w packages/pi-openai-reasoning pack:dry-run
```

Use the opt-in live smoke test in README after protocol changes. Never generate
images for a reasoning smoke test.
