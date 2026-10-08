# Contributing

Thanks for your interest in contributing to `pi-codex-compaction`.

## Development setup

Run from the monorepo root:

```bash
npm install
npm run -w packages/pi-codex-compaction check
npm test -w packages/pi-codex-compaction
npm run -w packages/pi-codex-compaction pack:dry-run
```

The package is source-distributed. Pi loads TypeScript directly; there is no
runtime build step.

## Pull request checklist

- Run package checks and tests.
- Run `npm run validate` for security-sensitive or cross-package changes.
- Inspect packed contents; never publish tests, session fixtures, or local settings.
- Update README, CHANGELOG, and SECURITY when their documented behavior changes.
- Never commit credentials, auth headers, private history, or opaque checkpoints.

## Coding guidelines

Use public Pi request, stream, and turn-end APIs. Preserve normal streaming and
the effective request rather than constructing a separate compaction request.
Do not restore legacy provider transport or the temporary compat serializer.

Automatic mode defaults on only for eligible public OpenAI requests. Preserve
off overrides, safe checkpoint bounds, cancellation, credential binding, ordinary
usage accounting, and standard Pi recovery. Never infer model-token counts from
ciphertext length or equate request count with cost.

## Regression and smoke tests

`tests/automatic.test.mjs` exercises real Pi sessions, serializer, tool loops and
session projection with fake credentials and mocked Responses streams.
`tests/default-mode.test.mjs` checks default policy, unsupported routes and
cache-warming decisions. No live requests are needed for ordinary validation.

Add integration coverage when changing checkpoint capture, ordering, replay,
threshold coordination, or message normalization. Keep a stream open to verify
text delivery before completion. Successful checkpoint adoption must not start
a second Pi compaction between tool continuations. Missing checkpoints must
leave the standard compactor available.

The gated `tests/benchmark-automatic.mjs` consumes subscription usage and is not
part of `npm test`. Obtain explicit approval before every live run. Use synthetic
text only, bound requests and input, and never print raw provider errors,
credentials, or encrypted content. `tests/AUTOMATIC_BENCHMARK.md` documents the
existing measurements and their limits.

For an approved TUI smoke test, follow the procedure in README. Check saved
checkpoint replay after reload, branch navigation and mode-off. Do not interpret
passing protocol tests as proof of long-session latency or cost savings.

## Code of conduct

This project follows the Contributor Covenant Code of Conduct.
