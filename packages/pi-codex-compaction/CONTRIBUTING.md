# Contributing

Thanks for your interest in contributing to `pi-codex-compaction`.

## Development setup

```bash
npm install
npm run -w packages/pi-codex-compaction check
```

This package is source-distributed: Pi loads the TypeScript extension files directly. There is no build step for runtime use.

## Pull request checklist

Before opening a pull request:

- Run `npm run -w packages/pi-codex-compaction check`.
- Run `npm test -w packages/pi-codex-compaction`.
- Run `npm audit --omit=dev`.
- Run `npm run -w packages/pi-codex-compaction pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-visible behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit API keys, tokens, auth headers, local settings, or provider configuration containing secrets.

## Coding guidelines

- Keep the Codex provider/API capability check explicit and future-compatible.
- Preserve current-model compaction, context bounds, cancellation, HTTPS, and standard Pi fallback behavior.
- Add a regression test when changing wire parsing, request construction, checkpoint rehydration, or model-switch fallback behavior.

## Token-budget regression and smoke checks

`tests/integration.test.mjs` uses the real Pi compaction hook, serializer, and
session tree with fake credentials and mocked Responses transport. A synthetic
long transcript must produce a remote checkpoint even when its UTF-8 bytes
exceed the numeric token budget. Oversized input must still invoke the standard
compactor and record a safe fallback reason. A later model request must not
contain the diagnostic entry. No private session fixtures or live requests are
needed for these tests.

The token conversion follows Codex's ordinary JSON-item heuristic:
[byte-to-token estimate](https://github.com/openai/codex/blob/654b0a77d0d2f81aa21f61caf7af4be88fe550bb/codex-rs/utils/string/src/truncate.rs)
and [history sizing](https://github.com/openai/codex/blob/654b0a77d0d2f81aa21f61caf7af4be88fe550bb/codex-rs/core/src/context_manager/history.rs).
This package keeps all serialized opaque/image bytes in its estimate instead of
copying Codex's modality-specific discounts. Never equate bytes and tokens or
remove the independent wire-size ceiling.

For an offline replay, reconstruct a compaction's discarded history in memory,
use fake authentication, replace `fetch` with a fixture checkpoint response,
and call `createRemoteCompaction`. Print only sizes and the success/fallback
code. Do not save the transcript, request, auth headers, or opaque content.

For an approved live smoke test, follow the procedure in [README.md](./README.md#reference-and-smoke-test).
Check for `fromHook: true` and `details.kind: "pi-codex-compaction"` on success.
On fallback, inspect only the reason and counters in the custom diagnostic
entry. Never inspect or print `encryptedContent`.

## Code of conduct

This project follows the Contributor Covenant Code of Conduct.
