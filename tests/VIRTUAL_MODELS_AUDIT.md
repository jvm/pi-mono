# Virtual models and classifier decision record

Investigation: [#170](https://github.com/jvm/pi-mono/issues/170), against Pi 1.1.0
and the package implementations at `dd81418`.

## Decision

**Keep the current conservative guards. Defer production routing and classifier
features.** Retain the offline integration suite and document the limitations.
Do not add a package, install a router, change a default model, or enable a paid
classifier.

No unsafe provider-feature activation was reproduced. Virtual selections lose
some extension features even when they route to a supported physical model.
That explicit unavailability is safer than guessing request identity.

A separate integration gap was reproduced: a classifier result returned to
`route()` is not automatically recorded as session usage. This is not a
regression in goal accounting: the result never enters the ledger it reads.
The research does **not** certify paid automatic routing as budget-safe.

One candidate consumer was exercised entirely in tests: opt-in ranking of a
small set of search snippets through codemode. If later justified by an
authorized quality/cost evaluation, it belongs near the existing `pi-web-kit`
consumer, not in a new router package or goal controller. The test script is
not a supported user-facing example or a production implementation.

## Physical versus virtual selections

| Integration | Supported physical selection | Unsupported physical selection | Virtual selection, including one listed under `openai` |
| --- | --- | --- | --- |
| `pi-fast` | Existing allowlist and per-request auth choose `fast` for public API keys or `priority` for subscription access | No extension-added tier | No extension-added tier, even after enabling Fast on a supported physical selection |
| `pi-codex-tools` | Responses API **and** advertised grammar capability activate model-only `apply_patch`; selected native file declarations are hidden, not replaced | `apply_patch` unavailable; native tools remain | Same conservative unavailability; supported physical dispatch does not activate the extension |
| `pi-codex-compaction` | Official public OpenAI Responses requests may opt into automatic compaction; checkpoint identity binds model/endpoint/auth mode/credential/relevant headers | No automatic opt-in or opaque replay | No automatic opt-in or opaque replay, even back to the same public model; an existing checkpoint supplies only its bounded readable fallback |
| `pi-openai-reasoning` | Verified legacy Codex Astra protocol only | Ordinary Pi thinking behavior | No extension-added `configuration_update`; the router's physical thinking level remains Pi-owned |
| `pi-goal` | Counts persisted assistant/tool/summary/usage entries | Same accounting | Physical assistant usage and persisted parent-tool classifier usage count once; unrecorded raw router classifier results cannot be counted |

This matrix concerns these extensions, not an arbitrary trusted extension's
request rewrites. It does not disable Pi's own grammar-capable codemode
declaration. Existing explicit tool selections, exclusions and model-only
boundaries remain authoritative. No DCG behavior or #166 limitation changes.

The new physical controls cover public API-key Astra, legacy OAuth Astra and a
small unsupported Chat Completions provider. Existing Fast tests cover public
OAuth as well. Neither set of mocks certifies live account access or billing.

## Request identity: what the public APIs expose

| Surface | Identity available | Suitability |
| --- | --- | --- |
| `ctx.model` and selected thinking level | Selected virtual catalog entry, not current physical dispatch | Insufficient to enable provider-specific features |
| Router callback and `ModelRuntime.resolveModel()` | Physical routing decision; the runtime validates the catalog model and credential availability | Useful to the router; calling the resolver again from an unrelated hook reruns routing and potentially paid classification, rather than observing the already-chosen request |
| `before_provider_request` | Mutable payload; context still names the selected model | No authenticated physical model/endpoint/auth snapshot; a payload model string is not authority |
| `before_provider_headers` | Mutable assembled headers; context still names the selection | Not a physical model/capability or effective-endpoint contract; do not inspect/log tokens to guess routing |
| `provider_stream_event` | Actual provider/API/model of the received stream | Too late for request preparation; does not supply the complete checkpoint auth identity |
| Assistant message | Actual provider/API/model and effective physical thinking level | Appropriate for response attribution and future sticky routing, not proof of the next request's identity |

A future integration needs a public, request-scoped resolved identity contract
at the appropriate loadout/request boundary, including effective endpoint/auth
identity and a relationship to the tool execution it governs. Observing the
previous assistant is insufficient: the next user turn may route elsewhere.
Do not replace executors, patch the installed runtime, mutate the selection to
impersonate dispatch, or introduce an event-bus approximation.

Pi owns transport/authentication. The fixture verifies that each dispatch uses
only that physical provider's synthetic credential, including when the selected
virtual model is listed under another physical provider. It also verifies that
codemode resolves classifier model references from the catalog rather than
trusting script-supplied endpoints or authorization headers.

## Routing, replay and branch behavior

- The deterministic test router uses `previous` for tool continuations and
  `failed` for retries. Routing is called with `user`, `continuation`, `retry`
  and `direct` reasons. This is an explicit router policy, not a host promise
  that every third-party router is sticky.
- Same-model tool continuation retains a synthetic thinking signature.
  Cross-provider handoff removes that signature and keeps its readable text
  through Pi's normal conversion. No universal cross-provider private-signature
  interoperability is claimed.
- A smaller physical context window triggers ordinary Pi compaction before
  dispatch. The already-chosen route stands. Standard manual summarization
  takes a `direct` route; a split history may make two summary requests from
  that one route. Direct routing has no branch state.
- Router state and selected virtual identity survive reload. Tree navigation
  restores earlier state rather than importing the abandoned route; a forked
  session starts with inherited state and then diverges. Goal totals follow
  their independent branch ledger.
- New user turns may switch providers. This can lose prompt-cache reuse.
  Disabling the private reasoning-update feature may also lose its cache
  benefit. Synthetic usage is not a cache-hit or latency measurement.
- A checkpoint created under a physical public model is not replayed opaquely
  through a virtual selection. Existing model/endpoint/auth/credential-rotation
  regression tests remain in the compaction package. The readable fallback is
  an excerpt, not a replacement full summary.

## Classifier accounting and failure evidence

All token values below are **synthetic fixture values**, not measured prices,
tokenization, quota use, or estimates for a real provider.

| Path | Observed outcome |
| --- | --- |
| Raw `ctx.modelRegistry.classify()` inside a router | Result reports 42 tokens; subsequent assistant reports 11. Session and goal contain only 11, with no classifier usage entry. Characterization test intentionally exposes the missing attribution. |
| `models.classify()` inside codemode | Parent tool contains the 42 classifier tokens; two assistant responses contribute 22. Goal total is 64, unchanged on reload/re-accounting. |
| Codemode cancellation after one completed classifier call | The second call receives cancellation. The first call's 42 reported tokens plus 11 assistant tokens remain counted once: 53. No follow-up provider request starts. |
| Router classifier failure or cancellation | Explicit `error`/`aborted` results; no physical chat request, persisted successful route, or goal completion. No usage reported by these synthetic failures is **not** proof that live failures cost nothing. |
| Test-only ranking | Disabled/missing-model paths make zero classifier calls; success makes at most three; invalid/low-confidence/error results stop and keep original order without retry or fallback to another paid provider. Reported usage, including error-result usage, still counts once. |

Pi's extension-facing session view is read-only; `pi.appendEntry()` writes
custom metadata, not a usage entry. The full SDK `SessionManager.appendUsage()`
exists for session owners, but is not a shared extension accounting solution.
An SDK-only control explicitly appends the missing 42-token usage entry and
verifies that session and goal then both count 53 tokens, once.
Before a paid router is adopted, define host-owned attribution for direct
classifier calls (including failed/aborted routes and summaries), cancellation,
branch behavior, and budget settlement. Do not guess usage or double-charge
codemode's existing parent aggregate. Missing provider usage remains unknown.

The candidate ranking script has a five-second script deadline, three
256-character snippets, a fixed query, typed score/range/confidence checks, and
stable original-order fallback. Its illustrative confidence threshold of 0.8
is **not calibrated**. A separate test exercises actual cancellation propagation
and preservation of completed-call usage. Typed choice and boolean probabilities
are also exercised.

Judgments never authorize actions or satisfy completion evidence. A high-scored
choice cannot bypass the ordinary `tool_call` denial, and `update_goal` remains
absent from codemode. Production DCG checks and goal continuation/verification
remain untouched; #85 and #166 are separate work.

## Deferred evaluation and security gates

Live evaluation was not authorized. Thus no claims are made about semantic
quality, p50/p95 latency, time-to-first-token, real costs, cache hit rates,
subscription quota, or net savings. Adoption would require:

1. An explicitly selected available classifier and separate paid-use approval.
   The documented native OpenAI Decisions path needs an API key; a ChatGPT
   subscription login alone does not authorize it.
2. A reviewed, bounded dataset and consent for sending its fields to the
   classifier provider. Never send credentials, raw session history or page
   contents merely because they are available. Provider-result redaction is
   not a general private-data detector.
3. Comparison with the existing deterministic ordering/no-classifier baseline,
   quality and failure thresholds, calibrated abstention, input/call/deadline
   limits, and measured additional latency/cost.
4. For routing, explicit switch/cache policy, provider/thinking compatibility,
   actual request identity and complete usage accounting. The current gap
   blocks paid automatic routing, not ordinary goal accounting.
5. Focused runtime tests and documentation/SECURITY review before any shipping
   feature. No new package, provider, credential flow, settings, default,
   install telemetry, or public production switch is added by this research.

## Reproduce and maintain

```bash
node --import tsx --test tests/virtual-models.test.mjs
npm run validate
```

`tests/virtual-model-harness.mjs` uses actual Pi registration, routing, native
serializers/parsers, hooks, codemode and session trees. Fetch and WebSocket are
intercepted; only synthetic in-memory credentials and disposable profiles are
used. OS tools are denied. Goals are synthetic and paused to avoid unrelated
continuation. Environment variables and owned temporary directories are restored
or removed on completion. No normal profile, external classifier, live model,
image generation, release or installation is involved.

The suite has 25 cases. Run it and the five affected package checks/tests on
the Node 22.19.0 floor and the supported Node 24 runtime. Root validation also
checks the unaffected packages and packed contents. On Pi upgrades, revisit
the identity/accounting characterizations rather than weakening their assertions
to hide changed behavior.

Local verification:

- Node 24.21.0: `npm run validate` passed, including 767 tests, all 13 package
  checks, package validation, pack dry-runs and zero production dependency
  vulnerabilities.
- Node 22.19.0: the 25 new contracts and all five affected package checks/suites
  passed, 336 tests in total.
- Semgrep security-audit/JavaScript rules scanned both new test files with no
  findings. Manual review checked bounded inputs, cancellation, authority
  separation and fixture isolation; a clean pattern scan is not certification
  of arbitrary extension composition.
- The five affected package archives contain their updated READMEs and no new
  test/research files. Manifests, lockfile, workflows and production source are
  unchanged.

Public references reviewed with the installed 1.1.0 declarations/implementation:
[virtual models](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/virtual-models.md),
[model operations](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md),
[codemode](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/codemode.md),
[extension events](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md),
and the upstream
[Jev router example](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/examples/extensions/jev-router.ts).
These sources document APIs and trade-offs, not local workload benchmarks.
