# Codemode decisions: D1, D2 and D3

## Recommendation

| Decision | Recommendation | Reason |
| --- | --- | --- |
| D1: package-level deferred exposure | **Implement a narrow, opt-in version for `pi-web-kit`.** | It provides selective schema reduction while ordinary file and shell tools stay direct. Global codemode-only mode is not an equivalent substitute. |
| D2: typed web extraction | **Defer indefinitely; remove it from the active implementation backlog.** | A credible specialist model exists, but an additional inference/data-flow path has not demonstrated enough incremental value over existing fetch/find/script workflows for this repository. |
| D3: image ledger normalization | **Defer indefinitely; retain informational counters.** | The subscription backend does not provide a verified mapping to image quota or charges, and Pi's usage shape cannot express unknown cost without inventing numeric values. |

D4 is outside this investigation at the user's request. “Indefinite” means no
scheduled implementation, not a claim that the feature can never become useful.
Reopening conditions are listed below.

## Method and limits

- Repository under test: the completed codemode implementation through
  `09bef1b`, with research-only files added afterward.
- Reference: `nicobailon/pi-web-access` at
  `9e276ddc70f4a9c8f63ebfff9897fc1ce5d75362`.
- Executed the research harness against actual Pi **1.1.0** and **1.4.0**.
  The latter used a disposable installation with synchronized host/AI/TUI
  versions and asserted their resolved paths.
- D1 uses real Pi registration, dispatch, codemode, discovery and request
  serialization, but scripted model responses and mocked web responses.
- D2 uses the reference's real extraction postprocessor, its 20 synthetic
  fixture pages/83 fields, deliberately injected provider answers, and the
  production cached finder. It does **not** measure live model accuracy.
- D3 feeds five synthetic completed streams through the production image
  parser and inspects the actual Pi usage contract.
- All inference, image and web-provider calls in the evaluation are mocked.
  Documentation retrieval is live. No paid inference, live image generation,
  private-content transfer, or production behavior change occurred.

Declaration sizes are UTF-8 bytes of the serialized declaration catalog,
including chronological additions. They are not billed tokens, measured
latency, prompt-cache savings, or autonomous task-success rates.

## D1: a useful selective control

The initial recommendation to defer D1 understated the difference between
**selectively deferring web tools** and **hiding every direct tool**.

### Measured cold declaration catalog

The synthetic mixed loadout includes web, process, Scout and image tools,
plus ordinary file tools. Only the five web tools are adapted to deferred
exposure in the prototype.

| Configuration | Pi 1.1 bytes | Pi 1.4 bytes | File/shell tools remain direct? |
| --- | ---: | ---: | --- |
| Direct tools, codemode off | 18,948 | 18,948 | Yes |
| Direct tools, codemode on, budget 3,000 | 29,491 | 30,695 | Yes |
| Deferred web, codemode on, budget 3,000 | 18,807 | 19,293 | Yes |
| Direct tools, codemode on, budget 0 | 26,614 | 27,583 | Yes |
| Deferred web, codemode on, budget 0 | 15,930 | 16,181 | Yes |
| Direct tools, codemode only, budget 0 | 4,315 | 4,436 | No |
| Deferred web, codemode off, native tool search | 11,781 | 11,781 | Yes |

With codemode on and budget zero, selective deferral removes **10,684 bytes
(40.1%)** on Pi 1.1 and **11,402 bytes (41.3%)** on Pi 1.4. Lowering the
inline budget alone does not remove direct web schemas.

There is a first-use tradeoff. Explicit discovery plus the full declaration
of `web_search` returned 4,937 bytes on 1.1 and 6,639 on 1.4. Scripts did not
activate direct declarations afterward. With codemode off, native
`tool_search` activated only `web_search`: the catalog grew from 11,781 to
14,074 bytes in both hosts, rather than loading all five schemas. Pi 1.1
serializes that addition chronologically; inspecting only top-level `tools`
would incorrectly miss it.

Nine configurations ran per host. All seven permitted configurations made
one mocked provider request. The two negative controls made none:

- Hidden web tools remained undiscoverable and uncallable after an explicit
  activation attempt and reload.
- An explicitly excluded deferred `web_search` remained undiscoverable and
  uncallable after reload.

These establish capability and visibility contracts, not whether a model
will reliably choose the best discovery query. The reference's reported
54% saving is a different, single-run experiment, not a pi-mono benchmark.

### Implementation recommendation

1. Start with the five read-oriented `pi-web-kit` tools, not process controls,
   Scout mutations, or image generation.
2. Keep direct exposure as the default; make deferred exposure explicit.
3. Use native `exposure: "deferred"` and native discovery. Add no loader.
4. Require a reachable discovery route: codemode or native tool search.
5. Keep a separate hard-disable policy. Inactivity is not a disable for
   deferred tools. Exclusions must continue to win across late registration
   and reload.
6. Add configuration/lifecycle tests before release. The prototype's metadata
   adapter is not a finished package configuration implementation.

## D2: plausible value, insufficient incremental benefit

### What the research supports

Cloudflare documents Clairic as a preview extraction model with typed
values, null probabilities, confidence and text spans. Published pricing is
**$0.10 per million input tokens**, with no output-token charge. Inference
price is therefore not the main objection. Schema and repeated-pass work
must still be included in actual usage; page length alone is not a bill.

Clairic is not the only implementation option. Existing fetch providers also
offer structured generation: Exa documents `summary.schema` on `/contents`,
and Firecrawl documents JSON-schema extraction through its v2 scrape JSON
format. Those could reuse an already configured provider instead of adding
Cloudflare. They still add inference semantics and charges, and their
documented schema conformance does not provide the plan's per-field
uncertain/missing/evidence contract. No live accuracy or cost comparison of
these alternatives was performed. If D2 is reopened, evaluate the configured
provider's native option before introducing a separate backend.

The reference reports zero wrong accepted values across two repeats of its
83 synthetic fields, plus abstentions. That is encouraging third-party
evidence, not our independently reproduced accuracy or latency measurement.
Repeats of the same fields are not additional independent test cases.

An oracle-size experiment separates potential output savings from accuracy:

| Dataset | Full page JSON | Oracle values through reference postprocessor, including confidence/citations | Change |
| --- | ---: | ---: | ---: |
| Calibration, 10 short pages/43 fields | 2,859 bytes | 4,549 bytes | 59.1% larger |
| Holdout, 10 longer pages/40 fields | 12,390 bytes | 4,210 bytes | 66.0% smaller |

These oracle answers are supplied by the fixture labels, not predicted.
They demonstrate that typed extraction can reduce longer-page output, but
can enlarge short-page output. They do not compare two models' accuracy.

Existing finding also handles a common extraction precursor: a synthetic
113,345-byte pricing page placed the Pro price after the initial slice.
Fetching once and finding `## Pro` returned a **507-byte JSON result**
containing `$24/month`, with **no additional provider request or inference**.
This supplies evidence to the existing main model, not a typed price verdict.

### What the safety evaluation establishes

The reference postprocessor accepted three deliberately wrong,
high-confidence answers:

- Starter price supplied for the requested Pro price.
- A beta version supplied for the requested stable version.
- A valid but invented date supplied for a page with no announced date.

The missing-text, low-confidence and null controls behaved as intended.
These are fault-injection results, **not an observed Clairic error rate**.
They prove that type validity, confidence and occurrence somewhere on the
page do not independently establish the requested semantic relationship.
Cloudflare's own preview guidance makes the same distinction between
well-formed and correct answers.

### Decision

Do not add a general extraction backend now. Keep fetch, cached finding and
script-side computation as the supported workflow. The potential benefits
are real for high-volume, repeated field collection; that workload has not
been established here. The new provider setup, privacy policy, evidence
contract, usage reporting and independent evaluation are not justified by
the measured output-size benefit alone. A new provider is not strictly
required; the missing evidence is an incremental workflow benefit and a
validated extraction contract, not merely credential availability.

Reopen only for a concrete repeated extraction workload that current finding
and scripts handle poorly. Require an independent live comparison against
that baseline, task-appropriate accuracy/abstention criteria, evidence spans,
and an approved public/private-content policy. Do not inherit the reference's
private-GitHub-content transfer behavior. An eventual first version should
be explicit and off by default, not inference hidden inside normal fetching.

## D3: observability is not normalized billing

The five parser probes covered complete counters, total-only counters,
missing counters, separate image-tool counters, and inconsistent totals.

The parser correctly remains an informational allowlist:

- Complete top-level input/output/total, cache and reasoning counters survive.
- A total-only record stays partial; missing usage stays absent.
- A separate synthetic `tool_usage.image_gen` record is not retained as
  top-level usage. Current counters therefore must not be advertised as
  complete image accounting.
- An inconsistent total is retained as reported, not validated as ledger
  data. Any future normalization would need consistency checks.

Public Responses documentation now describes separate image-tool usage,
but warns that incomplete records may be skipped and absent cache counts
mean unknown. That public API contract does not establish that the private
subscription endpoint supplies the same fields or billing semantics.
OpenAI also explicitly separates ChatGPT subscription billing from API
billing.

The Pi `Usage` type requires numeric input/output/cache fields and numeric
cost components. It has no unknown-cost state. Filling missing fields with
zero, applying public API prices to a subscription call, or charging both
aggregate and component counters would create misleading accounting.
Reasoning and cached-token subsets also need careful treatment; they are
not extra tokens to add to already inclusive totals.

### Decision

Keep D3 ledger normalization indefinitely deferred. Retain the documented
informational counters and unknown quota/cost. Do not modify `pi-goal` to
scrape renderer details or make its token budget look like an image quota.

Reopen when the actual subscription contract provides a verified,
non-overlapping usage mapping and the reporting path can represent unknown
cost honestly. Adding bounded, separately labelled provider diagnostics
could be useful later, but would not complete D3.

## Reproduce

Use a read-only checkout of the pinned reference and the root npm toolchain:

```bash
PI_WEB_ACCESS_REFERENCE=/path/to/pi-web-access \
  node --import tsx docs/research/eval-codemode-decisions.mjs

PI_WEB_ACCESS_REFERENCE=/path/to/pi-web-access \
  node --import tsx docs/research/eval-codemode-decisions.mjs 1.4.0
```

The first command uses the repository's installed dependencies. The second
creates a disposable synchronized installation, runs the same evaluation,
and removes that installation. npm may contact its registry for installation;
the evaluation itself blocks unmocked provider traffic. Optional
`PI_DECISIONS_OUTPUT` writes a JSON result to a **new** file with mode `0600`.

## Sources

- [Reference deferred-exposure experiment](https://github.com/nicobailon/pi-web-access/pull/591)
- [Pinned extraction design and published evaluation](https://github.com/nicobailon/pi-web-access/blob/9e276ddc70f4a9c8f63ebfff9897fc1ce5d75362/docs/field-extract.md)
- [Cloudflare Clairic model contract and pricing](https://developers.cloudflare.com/workers-ai/models/clairic/)
- [Cloudflare release notes and preview limitations](https://developers.cloudflare.com/changelog/post/2026-10-19-clairic-workers-ai/)
- [Exa contents schema and summary options](https://docs.exa.ai/reference/get-contents)
- [Firecrawl JSON extraction](https://docs.firecrawl.dev/features/llm-extract)
- [OpenAI Responses usage reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI subscription versus API billing](https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform)
- Local Pi 1.1/1.4 `ToolExposure` and `Usage` declarations; production image
  parser and goal accounting; research harness in this directory.
