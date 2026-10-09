# Native image-provider investigation

## Decision and scope

For #169, **defer a production native image adapter** and keep both existing
image tools. This is an evidence-backed design decision on Pi **1.1.0**, not a
claim that native image operations are unusable in general. The prerequisites
#158, #159, #164 and #165 are complete; deferral is not due to unfinished
prerequisites, #85, or deferred Compound Engineering.

The investigation adds offline ModelRuntime/codemode contracts and documents
their limits. It does not register a production image model, alter tool
exposure/defaults, introduce a new provider/package/credential flow, or enable
paid evaluation. No live image, chat, or classifier request is used.

One existing runtime defect was found and fixed: **configured but unresolved
owned image credentials must block legacy-account fallback**. The fix is
independent of native image registration. All other findings below are
characterizations, not fixes to Pi's generic image API.

## Evidence boundary

`native-image-harness.mjs` loads real Pi sessions, the production image and
goal extensions, native OAuth resolution, tool hooks, provider registration,
session accounting, and codemode. It uses the existing one-pixel PNG fixture,
in-memory synthetic credentials, a paused synthetic goal, disposable
HOME/agent/temp/session directories, and no user resources. Fetch and WebSocket
are intercepted; unexpected endpoints/credentials and executable OS tools are
blocked. Each test context owns one session and mocks each global once.
Cleanup aborts/disposes the session before removing owned temporary files.
Environment restoration assertions compare booleans, never print environment
objects or values.

With the native probe disabled, registration is unmodified. With it enabled,
the harness adds a **test-only** `type: "image"` catalog entry and a callback
that returns existing bytes. It retains the production OAuth provider but
does **not** implement a Codex native adapter or call its transport. Thus a
native callback count measures fixture invocations, not backend requests,
quota consumption, or a served model. Dedicated-tool controls exercise the
existing backend transport/parser through mocked Responses SSE.

### Observed contracts

| Boundary | Pi 1.1.0 evidence |
| --- | --- |
| Production discovery | `codex-images` is auth-only. Image/chat catalogs for it are empty; listing models and describing tools performs no generation. |
| Candidate identity | An explicit image discriminant keeps the probe out of `getModelOfType("chat", ...)` and chat listings. Mixed-operation `getModel()` can still return it; that is not chat support. |
| Owned auth | Native preparation uses the provider's OAuth. Unsupported stored API keys do not invoke the native callback. The current tools independently reject non-OAuth auth sources. |
| Absent owned auth | Native preparation does not automatically inherit the dedicated tool's legacy-provider fallback. With only fixture legacy OAuth, native preparation errors before generation while the dedicated tool succeeds. |
| Invalid owned auth | Malformed owned OAuth fails without switching to legacy. Unsupported stored credential types exposed a separate tool fallback bug, fixed below. |
| Script model references | Codemode resolves only provider/id against the typed catalog. Forged script base URLs/headers do not reach the native callback. |
| SDK model objects | Trusted SDK callers can supply model objects with a different base URL. A Codex transport must keep its fixed endpoint and controlled headers rather than trusting that object. This is not a claimed SDK security-boundary bypass. |
| Generic input | Scripts validate nonempty arrays and block shapes, not the package's 32,000-character/five-image/MIME/base64/byte limits. A 32,001-character prompt and six invalid image blocks reach the probe. |
| Controls | Extra context keys pass through, but are not documented controls. Codemode does not forward a third options argument. SDK `ImagesOptions.metadata` is available; it is not a portable script API. |
| Edits | Explicit image blocks from `read` and previous native outputs can be passed to another call. Each call is a separate operation. No path/recent-branch selector is inferred. |
| Native results | Small results retain bytes, operation identity, response ID and reported usage. `image(block)` explicitly displays and saves a temp copy. It creates no package recovery entry. |
| Undisplayed results | Returning from or failing a script before `image()` leaves a warning but no saved original or `/image-artifacts` entry, including after reload. |
| Save failure | Generic display keeps the inline image and a save warning if temp storage fails. It does not create the package's pre-generation reservation or recoverable artifact. |
| Large results | A 13 MiB padded PNG, below the package's 32 MiB limit, completes the fixture operation but fails `image()` with QuickJS regexp memory exhaustion. No original is saved. This is a transport probe, not a realistic image/decoder benchmark. |
| Aggregate output | Text and base64 image output share 16,777,216 characters. Filling that budget with text rejects even the tiny PNG after generation, while keeping prior output and reported usage. No original image is saved. |
| Permission boundary | Native `models.generateImages` calls have UI call rows but do not traverse the named image tools' `tool_call` hooks. Denying or excluding those tools does not remove a separately registered native operation. Blocking the outer codemode tool still blocks the script. |
| Failure/cancellation | Native errors are terminal result data, not necessarily failed scripts. Callers must check `stopReason`. No host generation retry is observed. Cancellation reaches a pending callback; previously completed reported usage remains counted. |

Do not re-enable nested calls to the inline image tool or weaken output bounds
to make the generic path resemble the dedicated path. A permission hook's
absence is not authorization to generate; the probe only identifies an
additional policy surface that would need explicit approval.

## Authentication regression

Pi's native auth resolver returns `undefined` for a stored credential with no
matching provider auth handler. `imageAuthProvider` is OAuth-only, so a stored
API-key credential for `codex-images` cannot resolve. Previously
`resolveImageAuth()` interpreted that as an absent owned login and attempted
legacy OAuth, even though an owned credential was configured.

The shared tool execution path now checks the public
`getProviderAuthStatus(provider).configured` when owned resolution returns
`undefined`. Configured-but-unresolved auth produces the existing controlled
authentication error before any image request. The extension neither reads
auth files nor copies credentials. Absent-owned fallback and successful owned
OAuth stay unchanged; auth failures still do not switch accounts.

Real-session cases exercise both direct inline and nested artifact calls,
with production registration and with the native probe. Removing the guard
reproduces a legacy request attempt. A malformed owned OAuth control verifies
the existing failure path, and the absent-owned control verifies that the fix
does not disable legitimate legacy fallback. The status check follows Pi's
current auth configuration view; it is not a new cross-process credential
transaction or a change to host refresh semantics.

## Candidate contract, if reconsidered

This is a design boundary, **not an approved implementation or usable config**.

| Area | Required contract |
| --- | --- |
| Catalog | Keep provider ownership under `codex-images`; use an explicit image operation with a neutral operation ID/name, not a claimed `gpt-image-*` served-model selector. No chat model entry. A display/routing identity is not served-model evidence. |
| Routing | The Codex routing model and backend-selected image model remain distinct. Never infer served model/quality/size/background from catalog names, prompts or successful requests. |
| Minimum | Pi 1.1.0 / Node 22.19.0 is the tested baseline. Earlier native APIs existed in 0.99 and codemode integration in 1.0; this work does not certify those versions. |
| Input subset | A candidate can explicitly accept one nonblank text prompt plus zero to five PNG/JPEG/WebP blocks, retaining all current byte and prompt limits. Reject unsupported options/orderings rather than silently claiming parity. |
| Dedicated controls | `model`, `outputFormat`, `save`, `saveDir`, local paths and recent-conversation selection remain on the dedicated tools unless a separately documented API can represent them. Generic `ImagesContext` has only `input`; do not smuggle controls into undocumented keys. |
| Result | Standard `AssistantImages` carries `api`, `provider`, `model` (operation identity), `output` text/image blocks, optional `responseId`/`usage`, terminal reason/error and timestamp. It has no standard typed artifact, save-warning or backend-reported-properties field. Bounded text is possible, but is not equivalent to the artifact tool's structured contract. |
| Delivery/recovery | Preserve original bytes, not a silently resized substitute. Before quota work, define private-original storage and origin-branch recovery even when a script never displays, exceeds limits, times out, or changes sessions. A generic provider callback has no `ExtensionToolContext`, originating tool-call ID or session-branch writer. Do not capture a mutable “latest context.” |
| Save semantics | Current direct `save: "none"` writes no image file; artifact `none` still reserves/retains a temporary original. Generic display writes a temp copy independently. A new default must not silently change those distinctions. |
| Approval | Define native-operation authorization and disabling semantics explicitly. Registering the operation must not make denied/excluded image tools usable through another route. Native call rows and model metadata are not approval evidence. |
| Auth | Keep owned OAuth, only-when-absent legacy compatibility, no switch on auth/generation failure, and no plan-sharing/Codex-app/API-key fallback. Native provider auth preparation alone does not implement cross-provider fallback. Retain cancellation, redaction and fixed endpoint/header policy. |
| Network/quota | Reuse the existing deadline, parser, bounded HTTP retry policy and no automatic repeats for quota, connection, failed/incomplete stream or storage failures. Repeated invocations are new quota-consuming operations, not a recovery method. |

`requestImage()` currently lives in `extensions/index.ts`, shared by both
tools; parsing, OAuth and artifacts have separate modules. If an adapter is
approved later, first extract a single shared generation boundary with typed
validated input and byte/result metadata. Keep each caller's delivery/state
policy outside that transport. Do not copy the request/parser/auth code,
dispatch twice, retry through another route, or invoke the direct model-only
tool from a provider callback.

A raw SDK-only adapter with reduced controls is technically possible, but it
would not provide the requested safe codemode parity. A thumbnail plus an
original path, a native per-operation permission hook, or a host-owned
artifact-aware result channel would each need a reviewed contract and tests.
No such mechanism is shipped here.

## Usage, pricing and quota

The standard `Usage` shape requires input/output/cache counts, total tokens,
and numeric cost fields. The backend currently reports a possibly partial set
of numeric Responses counters, retained in the tools' `details.usage`.
Those fields do not automatically become ledger entries and do not describe
remaining image quota or a subscription bill. Do not copy arbitrary backend
metadata or estimate missing counts to fabricate complete usage.

Synthetic accounting controls:

- Native codemode call: **42** reported tokens plus two **11**-token assistant
  messages gives **64**, unchanged by reload/re-accounting. A reported error
  also counts its 42 tokens.
- A second cancelled call after one completed native call retains the first
  **42**, plus the initial assistant's **11**, for **53**, without a follow-up
  chat request or generation retry.
- A tool wrapper that reports its own raw native result's usage gives **64**
  through nested codemode, not 106. Codemode aggregates `models.*` calls; Pi
  separately aggregates nested tool results. Do not report the same work on
  both paths.
- Raw SDK/extension native call: the result reports **42**, but session/goal
  totals remain **0** without caller attribution. This is the same ownership
  distinction characterized for classifiers in #170, not free generation or
  a regression in goal accounting.
- Existing artifact tool: backend `details.usage.total_tokens` is **42**, but
  only the two assistant messages (**22**) enter the ledger. No usage change
  is shipped here.
- An error with no reported usage adds no inferred tokens. That is not a claim
  about a live provider's charge.

The fixture's zero prices are synthetic only. A production design needs
explicit treatment of unknown/unpriced subscription cost and partial/missing
usage, plus exactly-once attribution of successful, failed, aborted and
post-generation delivery failures. Simply assigning catalog price zero must
not be presented as verified free generation.

## Existing tool acceptance retained

The package's `image-generation.test.mjs`, `codemode.test.mjs` and
`image-oauth.test.mjs` remain the controls for fixed endpoint/headers, OAuth
refresh, absent-only fallback, token redaction, PKCE/state, bounded streams,
cancel/deadline behavior, no quota retry, save modes, private originals,
32 MiB outputs, bounded explicit display, local/recent references, failed-save
recovery, and reload/branch/fork/session-replacement recovery. The native
investigation does not duplicate or replace those tests.

The only runtime change is the auth guard above. README, imagegen skill,
CHANGELOG and SECURITY describe that fix and the native limitation. Root
index, manifests, lockfile, workflows, telemetry, defaults, and release
metadata need no changes. Neither tools nor exports were removed.

## Reproduce and acceptance map

```sh
node --import tsx --test tests/native-images.test.mjs
npm run -w packages/pi-codex-image-gen check
npm test -w packages/pi-codex-image-gen
npm run -w packages/pi-codex-image-gen pack:dry-run
npm run validate
```

Use fixture credentials and existing pixels only. No live experiment is a
prerequisite. The suite contains **29 tests**, including its teardown subtest.

Local verification:

- Node **24.21.0**: root `npm run validate` passed **800 tests**, all 13 package
  checks, structure validation and pack dry-runs; the production dependency
  audit reported **0 vulnerabilities**.
- Node **22.19.0**: the 29 contracts plus image (**115**) and goal (**128**)
  suites passed **272 tests**; both affected package checks passed.
- The two configured-API-key regression cases fail against the original
  production source and pass with the guard. The full suite also exercises
  legitimate legacy fallback and both tool entry points.
- Semgrep scanned the changed runtime file and both new test files with **89
  applicable rules**, complete parsing and **0 findings**.
- The image archive contains **26 intended files**, including the guard and
  updated user/skill/security documentation, without root tests/research,
  agent files, generated builds or settings.

| #169 criterion | Disposition |
| --- | --- |
| 1. Supported design or evidence-backed rejection | Defer native adoption; delivery/recovery, control and permission differences are demonstrated, not inferred only from docs. |
| 2. Identity, controls, result, usage, minimum | Defined above; prospective choices are not advertised features. |
| 3. Coexistence without double billing/reduced features | Retain both tools; define one shared transport if later approved, preserve separate delivery policies, and test exactly-once usage ownership. |
| 4. No-save, failed saves, quota and large outputs | Current contracts retained; generic missing-original, display/save-failure, VM and aggregate-limit cases demonstrate why parity is not certified. |
| 5. Runtime/codemode tests if approved | No adapter approved. Real-session probes nevertheless verify generic image delivery with mocked results and the production auth regression. |
| 6. User/security docs for shipped changes | Updated for the small auth fix and limitation; no new generation data flow or vendored Python changes. |
| 7. Preserve direct behavior | Current entry points remain available; original package suites remain required. |

References: installed Pi 1.1.0 declarations and implementations for
`ModelRuntime`, `ModelRegistry`, `AssistantImages`, auth resolution and codemode;
the upstream
[custom-provider guide](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/custom-provider.md)
and
[codemode guide](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/codemode.md).
The investigation provides no live backend availability, model identity,
quality, latency, pricing, quota, TLS or multi-platform image-decoder
certification.
