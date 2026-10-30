# Codemode implementation record

## Decisions

The user approved these outcomes before implementation:

- D1: Defer package-level deferred exposure. Keep direct defaults and test native discovery.
- D2: Defer typed extraction. Add no inference backend or data destination.
- D3: Defer image ledger normalization. Backend counters remain informational, not verified costs or quota.
- D4: Characterize host defects and track upstream. Do not add private host patches.
- Physical-terminal and macOS manual smoke: explicitly deferred by the user to
  release testing. Automated real-selector, SDK, TUI/RPC fixture and native PTY
  checks are not described as a human-operated terminal run.

This work does not authorize publishing, pushing, image generation, or inference spend.

These decisions describe the initial implementation batch. D1 was subsequently
approved and implemented in `pi-web-kit`, then refined to automatic behavior:
active native codemode defers enabled web tools; otherwise tools stay direct.
There is no exposure setting. An independent hard disable and native
exclusions remain available; see its README and registered-tool tests.
D2/D3 remain deferred, and D4 was removed from follow-up work. Image generation
remains subscription-only.

## Validation

Pi 1.4.0 is now the only development and contract-test target. Older-host results
below are historical evidence, not an active support matrix.

`npm run test:host` uses a disposable repository copy and installs synchronized
Pi 1.4.0 dependencies there. Tests assert the resolved host version and path.
The runner rejects older or floating targets. No dependency inputs in the
working repository are changed by the runner.

Declaration measurements report UTF-8 bytes and byte-derived token estimates, not
billed tokens. Declaration, discovery/catalog, and retained output sizes are separate
measurements. These measurements do not predict latency, cost, or prompt-cache hits.

## Requirement map

| Workstream | Verification |
| --- | --- |
| A, J | `structured-tools` captures direct/on/only declarations, zero-budget discovery, separate cold/discovery/warm/resumed output sizes; `test-pi-compat` asserts real resolved host/AI/TUI versions in disposable installs. |
| B | Real registered process namespace/exclusion tests plus package session, completion, task-delivery, output/render, native PTY tests and SDK host smoke. Per-write approvals and explicit nested acknowledgements remain unchanged. |
| C | Registered direct and real codemode mixed/all-failed search tests; provider shape, validation, cancellation, redaction, renderer and budget tests. |
| D | Nested six-request and three-duplicate probes; coordinator account isolation, queue cancellation and independent waiter cancellation; existing cache/provider/fallback tests. HTTP admission and logical batch identity stay separate. |
| E | Real nested cached finder beyond inline content; cache-miss error without network; existing range, cache expiry, redaction and output-budget tests. |
| F | Registered typed Scout listing, revision invalidation and public-field tests; compact/fallback prompt tests plus shared reload/tree/fork/skill composition contracts. |
| G | Fixture-image direct/nested admission, failed-script typed recovery, missing files, cancelled queues/reload and quota-failed siblings; existing branch/manifest/fork and save tests. No live image calls. |
| H | Existing exactly-once goal ledger/session tests run on Pi 1.4.0; actual image backend counters remain informational in a cross-package regression. No guessed charge or quota mapping. |
| I | The Pi 1.4.0 host runs DCG/process exact-argument and UI contracts, goal accounting, codex native-edit contracts, and automatic compaction discovery/activation/reload/checkpoint tests. Shared prompt tests retain skill visibility controls. |
| K | User-deferred under D2: no inference provider, extraction options or inference spend. |

### Host ownership

The earlier-hook input-object replacement defect is reproduced in Pi 1.4.0
by `pi-dcg/tests/session-contract.test.mjs`. Its owner is Pi tool dispatch:
the checked `event.input` and executed arguments must have the same identity.
Keep this characterization when proposing an upstream fix; do not remove it
or label it a successful safety guarantee.

Pi 1.4's host-owned dialog stack restores an independent prompt after the visible
one closes;
the mixed DCG/process test exercises separate denials. No private host patch
or cross-package runtime dependency is introduced.

The demonstrated compaction adapter gap was Pi 1.4's native reasoning-effort
updates. Only their exact known shape is accepted and preserved chronologically;
unknown configuration remains fail-closed. This is a package adapter change,
not a host patch or new serializer.

## Automatic exposure follow-up

`structured-tools.test.mjs` now exercises real native registrations in normal,
`on`, and `only` interactions. It covers both toggle directions, same-script
changes, zero-budget discovery, native-search declarations, manual choices,
settings/CLI exclusions, hard disables, late credentials, model changes,
reload/resume/fork, and old tree snapshots with pending optional definitions.
Live executor guards also reject a deferred executor captured before a later
tool-call hook changes its selection. No private host API is patched.

The short `web_research` section composes with unrelated sections and respects
native full-prompt overrides at provider projection. Branch bookkeeping is
validated, bounded to fixed tool names, excluded from model context, and not
appended again for unchanged selections. Packed files include the new runtime
module but exclude tests and agent files.

Pre-merge regression tests also cover native CLI flags applied after extension
registration, first-prompt/reload compact Scout context with exclusion fallback,
UTF-16 finding that starts inside a surrogate pair, and overlapping HTTP 429
responses that extend an already-waiting request's cooldown.

Use `PI_OFFLINE=1 PI_TELEMETRY=0 npm run validate` for reproducible local
acceptance without best-effort install telemetry entering fetch-count fixtures.
These controls disable telemetry, not research providers. Run the isolated
Pi 1.4.0 checks with `npm run test:host`.
Run root validation and the isolated host checks sequentially on a shared host:
their image OAuth fixtures use the same loopback callback port, 1455.

## Pi 1.4.0-only baseline acceptance

- All 15 workspaces pin Pi 1.4.0 for development; host-provided peer ranges stay `*`.
- Node 24 root validation passes with 1,267 tests and two expected opt-in skips,
  all package checks, a zero-vulnerability production audit, and pack dry runs.
- `npm run test:host` passes 474 tests without skips, including the additional
  compaction-host suites, actual resolved-version/path checks, raw grammar
  transport, virtual-model thinking isolation, and the reasoning checkpoint fix.
- SDK process smoke and the subscription-usage/native Fast authentication smokes
  pass with synthetic credentials and mocked transport.
- All 15 package archives exclude test fixtures, agent files and local settings.

## Historical acceptance results (initial implementation batch)

- `npm run validate`: passed all package checks/tests, package consistency,
  production audit (zero vulnerabilities), and pack dry runs. Two existing
  opt-in compaction-host files remain skipped in the default root suite;
  their 13 tests run explicitly in the Pi 1.4 isolated lane.
- Pi 1.1.0 isolated lane: 265 shared/contract tests and 120 fixture-image tests
  passed, with no failures or skips; SDK process smoke passed.
- Pi 1.4.0 isolated lane: the same 385 tests, 13 additional compaction-host
  tests (398 total), and SDK process smoke passed, without failures or skips.
  Each lane asserts the actual host, AI and TUI dependency versions and paths.
- Inspected packed files for processes, web, Scout, images, compaction, DCG and
  goal: no tests, agent files, plan, credentials or generated test builds.
- Synthetic declaration fixture with bash included: direct declarations were
  19,149 bytes before concise wording and 19,119 afterward. This small reduction
  is not a billed-token or cost claim. Final isolated baseline samples measured
  27,445 bytes for `on` and 6,189 for zero-budget `only`; visible namespace
  discovery added 1,884 output bytes. Cold, warm, resumed and retained-output
  measurements remain separate in test diagnostics; cache effects are unmeasured.
- No Compound Engineering files or instruction blocks changed. No push,
  publication, live image request or extraction inference was performed.

## Release testing decision (2026-10-30)

For these releases, the user approved publication after automated checks and
waived the deferred human physical-terminal/macOS smoke test. It was not run.
Linux/macOS CI, native PTY tests and Pi 1.4.0 SDK/TUI fixtures remain the release
evidence; they do not certify terminal pixels, IME or emulator image placement.

PR review also reproduced a provider response disconnect after headers that
discarded earlier successful queries. Direct and native codemode regressions
now cover partial/all-failed HTTP, network and body-read failures. Registered
search controls keep cancellation, oversized responses, malformed JSON and
invalid response shapes fatal; a real loopback socket disconnect verifies the
body-read error classification without sending research data to a provider.
