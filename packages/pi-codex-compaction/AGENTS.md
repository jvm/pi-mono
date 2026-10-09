# pi-codex-compaction Guidelines

Root `AGENTS.md` applies.

## Invariants

- Default automatic `context_management` on for eligible requests; preserve explicit off settings and Pi's standard recovery compactor.
- Enable it only on the official public `openai`/`openai-responses` route for GPT-5/GPT-6 candidates. Do not change providers, credentials, or billing mode.
- Do not restore legacy backend transport, beta headers, compat serializers, or direct-compaction event-bus adapters.
- Stop cache warming only when the actual cached request used automatic compaction. Leave unrelated providers and skipped requests unchanged.
- Adopt only completed, bounded, ordered output. Use `output_item.done`, not `output_item.added`; the terminal output array can be empty.
- Replay the latest checkpoint and its exact output suffix without duplicating the normalized assistant message or dropping later tool results.
- Keep ordinary response usage on the assistant entry, never duplicate it on the checkpoint.
- Verify retained output through the public provider payload boundary with transport disabled. Do not resolve physical Pi AI files or import its serializer subpaths; packed-load tests must not install or link host peers.
- Bound captured and persisted output, honor cancellation, and never log prompts, credentials, headers, or encrypted content.
- Preserve Pi's standard compactor as a safety net. Do not claim lower cost or latency without measured evidence.

## Validation

```bash
npm run -w packages/pi-codex-compaction check
npm test -w packages/pi-codex-compaction
npm run -w packages/pi-codex-compaction pack:dry-run
```
