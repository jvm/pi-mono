# Automatic compaction: live comparison

## Scope and authorization

Tested the public `openai` / `openai-responses` route with an existing ChatGPT
subscription credential and `gpt-6-astra`, using the repository's Pi 1.1.0
dependencies. No API-key billing, private session history or images were used.
The user authorized eight Responses requests, then two additional verification
requests after a stream-shape bug was fixed. Ten requests were sent in total.
No further live requests are part of ordinary validation.

## Reproduction

Requires explicit permission to consume subscription usage and a valid existing
OpenAI ChatGPT sign-in. The script refuses API-key credentials, blocks
non-Responses traffic (including refresh), and never prints raw errors, tokens,
headers, prompts or encrypted checkpoints.

```bash
PI_LIVE_COMPACTION=1 node --import tsx packages/pi-codex-compaction/tests/benchmark-automatic.mjs
```

The script limits a run to eight HTTP requests and 150,000 cumulative serialized
request bytes as a conservative text-input token preflight bound, not an
estimate of actual billed usage. Each request has a three-minute deadline.
`--probe` runs only the two automatic requests with a 30,000-byte preflight ceiling. Repeat runs require renewed
permission; the ceiling is per process, not a persistent allowance.

The fixture contains synthetic audit notes and four facts: ORCHID, port 4317,
SAFE_MODE, and a prohibition on renaming the ledger table. Both arms receive the
same prior messages and two questions. The standard arm calls real
`AgentSession.compact()` before answering; the automatic arm configures a
1,000-token server threshold and lets ordinary inference trigger compaction.
Reasoning is low; no tools execute; no Fast tier is requested.

The low threshold is intentional to test the complete protocol on a small
budget. It is not a recommended production setting. The server emitted two
checkpoints per automatic response. Pi's standard arm used two summary requests
because the fixture exercised a split user-message span.

## Observed protocol issue and regression

The initial six-request comparison and a two-request diagnostic probe showed:

1. `response.output_item.done` emitted ordered compaction/message/compaction items.
2. `response.completed` had `status: "completed"` but `output: []`.
3. Reading only the terminal array missed checkpoints and resent original history.

The extension now collects the bounded done items by `output_index`, requires
contiguous unique indices and successful completion, and uses the latest
checkpoint plus the exact suffix. Nonempty terminal output must agree with the
streamed items. Regression fixtures reproduce the empty terminal array by
default, rather than simulating only the easier full-array response.

The final two authorized requests verified adoption and actual checkpoint
transmission on continuation. No fallback summarizer ran in that arm.

## Results

The corrected automatic measurements and the earlier standard baseline:

| Metric | Automatic | Standard Pi |
| --- | ---: | ---: |
| HTTP Responses requests | 2 | 4 |
| Compaction plus first answer | 14.305 s | 21.231 s |
| Standalone compaction portion | Included in inference | 17.077 s |
| Continuation | 10.463 s | 3.137 s |
| Sum of measured elapsed intervals | 24.768 s | 24.368 s |
| Input tokens | 4,037 | 3,088 |
| Output tokens | 450 | 348 |
| Total tokens | 4,487 | 3,436 |
| Reported cache-read / cache-write tokens | 0 / 0 | 0 / 0 |
| First-answer fact-presence checks | Passed | Passed |
| Continuation fact-presence checks | Passed | Passed |
| Extension errors | 0 | 0 |

Automatic continuation transmitted a checkpoint and reduced its serialized
request from 9,433 bytes on the first turn to 4,126 bytes on continuation. Ciphertext bytes
are not its model-token footprint.

## Interpretation

The intended user benefit is **continuity**, not merely a lower sum of request
durations: ordinary inference should continue across the checkpoint without
entering Pi's separate summarize-and-resume lifecycle. The original comparison
did not measure time to first text or streaming gaps. It disabled Pi's automatic
safety net and invoked the standard summarizer explicitly, so it is a protocol
smoke test, not a representative long-session flow benchmark.

The script now records time to first text delta, maximum interval between text
deltas, checkpoint completion times, response completion time, and local
compaction-hook calls. These measurements were added **after** the live trial;
no streaming-latency values can be inferred from the table above. A gap includes
any provider work between text deltas, not only compaction.

Offline real-Pi regressions additionally verify that:

- Text reaches Pi's message stream while the response is still open, before
  checkpoint commitment.
- With normal default threshold selection and Pi auto-compaction enabled, an
  adopted checkpoint prevents stale pre-compaction usage above Pi's threshold
  from triggering a second summarization.
- Tool results proceed into the next inference request with no
  `session_before_compact` call or `compaction_start` event.
- The standard compactor still runs when no checkpoint was adopted and its
  threshold is exceeded.

The feature works end-to-end without upstream Pi changes. This trial **does not
establish that it is cheaper or faster overall**:

- First-answer latency fell about 33%, and there were two fewer client requests.
- Total elapsed time was about 1.6% higher.
- Reported total tokens were about 31% higher.
- Subscription tokens are not a dollar invoice or a measured credit charge.

This is one small synthetic, non-concurrent comparison. It does not establish
p50/p95 latency, cache benefits on long coding sessions, or task-quality
equivalence. Recall assertions check expected strings, not semantic equivalence
of the full answer. The corrected automatic arm was measured after the standard arm,
not as a randomized paired experiment. No GPT-5 live test or API-key test was
performed. Use representative long-session comparisons before making a
performance claim. The implementation subsequently changed to default-on for
eligible public requests, with explicit opt-out and standard Pi recovery; that
product decision does not change these measured results or authorize more tests.

## Documentation and Codex cross-check

The [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
explicitly describes a compaction item emitted in the same response stream,
followed by continued inference. No separate `/responses/compact` call is
required. This does not promise zero latency or concurrent inference during the
compaction pass; “automatic” is not the `background: true` API option.

Codex main `9b738582b13c2cdbeff54af0afd04c50c3e7ba09` also has a different,
explicit native-compaction path:

- `codex-rs/core/src/compact_remote_v2_attempt.rs` adds `CompactionTrigger` and
  uses normal model-visible tool specs and the Responses client.
- `codex-rs/core/src/session/turn.rs` awaits compaction before or between model
  steps. It also supports post-turn compaction when configured and no input is
  queued. Those history changes remain serialized in the turn task.
- `model_post_turn_compact_threshold_percent` defaults to zero in that source,
  so post-turn compaction is not an unconditional default.
- `codex-rs/tui/src/chatwidget/compaction.rs` explicitly displays “Compacting
  context” for this path.

Thus a smooth Codex session is not proof that its particular client/configuration
uses public `context_management`, nor proof that all compaction is asynchronous.
The extension's automatic mode follows the public in-stream contract rather
than claiming to reproduce every Codex compaction path.

## Pi 1.4 inline-tool follow-up

This section records the earlier safety-only patch and snapshot prototypes.
It is historical evidence, not the current implementation. The automatic
adapter selected after the later comparisons is described below.

The earlier Pi 1.1 result does **not** establish compatibility with Pi 1.4's
native tool serialization. An additional, separately authorized live run used
the installed Pi 1.4.0 SDK, the public Responses endpoint, and existing ChatGPT
sign-in. Models were `gpt-6-astra` and `gpt-6-sol`; no API key, private history,
images, Fast tier, credential refresh, or automatic retries were used.

The complete follow-up consumed the approved **36 HTTP requests** and
**399,923 cumulative serialized input bytes**, below the 1 MiB input ceiling.
Every request had a 90-second deadline. Provider-reported aggregate usage was
113,234 input tokens and 7,475 output tokens. There were 34 streamed compaction
items and 32 successful harmless fixture executions, including nested codemode
calls. These are subscription usage counts, not measured dollar charges.

| Request shape | Requests | Observed result |
| --- | ---: | --- |
| Unmodified Pi 1.4 inline declarations with automatic compaction | 1 | Reproduced missing tools in the same response; no fixture executed |
| Safety patch, native inline requests and saved-checkpoint repair | 4 | Function calls on Astra/Sol, grammar call on Astra, and restored-checkpoint tool execution passed |
| Experimental current-state top-level snapshot | 17 | Function/grammar calls, tool continuations, changing loadouts, repeated checkpoints and session lifecycle checks passed; includes one checkpoint-seeding request |
| Experimental namespace-wrapped current-state snapshot | 14 | Same Astra lifecycle checks, codemode-only loadout, and explicit named-namespace function/grammar replay passed |

The two snapshot experiments use the public `context_with_system` event and
`getCurrentSystemMessage()` to fold system/tool state into a current request
snapshot, then move the provider's serialized tool declarations from
`additional_tools` to top-level `tools`. One sends the declarations directly;
the other wraps them in a namespace. No private provider serializer is used.

The tested variations included:

- A checkpoint followed by a function call in the **same response**.
- A two-step tool sequence with a checkpoint on each assistant turn.
- Raw Lark-grammar input and replay of the corresponding custom-tool result.
- Tool registration and removal, followed by a same-name schema replacement.
- Restoring an in-memory session tree, extension reload, and navigation to an
  earlier checkpoint.
- Mode-off replay without requesting another checkpoint.
- Astra and Sol function/grammar compaction on the direct top-level variant.
- Codemode with both ordinary and `only` loadouts; `only` sent just codemode,
  not its hidden callable fixtures.
- A non-default `synthetic_fixtures` namespace, with the exact namespace retained
  on both function and custom calls across checkpoint replay.
- The safety patch reopening a synthetic checkpoint produced before the guard,
  restoring inline declarations and executing the current tool.

The original inline arm failed as expected; the other tested checks passed.
The experiments were sequential synthetic protocol checks, not randomized
performance trials. The namespace-wrapped arm was not separately repeated on
Sol. No live GPT-5, GPT-6.1, API-key billing, long-running production workload,
or TUI interaction was tested.

### Interpretation at that stage and retained regressions

The safety patch was a verified, narrow recovery fix. It deliberately gave up
automatic server compaction on the native inline-tool route rather than risking
tool loss.

The snapshots established that full server-side compaction with functioning tools
was feasible on Pi 1.4. Those history-folding prototypes were not selected. Folding
all system messages changes the temporal placement of prompt sections and tool
updates, and changes the cached prefix when the loadout changes. Those broader
semantics need a separate adapter design and skipped/disabled-path contract;
passing this matrix does not prove equivalence for arbitrary extensions or
establish a globally optimal fix.

`host-inline-tools.test.mjs` retains the native-host safety regressions with all
transport mocked. It loads the actual source through the installed host's
extension loader and uses only public SDK/provider boundaries. An explicit
test-only top-level adapter seeds synthetic legacy checkpoints before reopening
them with the unmodified candidate entry. Coverage includes calls/results on
both sides of the checkpoint, namespaces, removals/redefinitions, off/reload/
branches, hidden tools on fresh and restored sessions, and standard Pi threshold
compaction after a guarded request.

```bash
PI_COMPACTION_HOST_ENTRY=/path/to/pi-coding-agent/dist/index.js \
  node --import tsx --test packages/pi-codex-compaction/tests/host-inline-tools.test.mjs
```

This command does not consume inference usage. Ordinary `npm test` skips the
installed-host suite unless that public entry path is supplied; pinned-peer
regressions still emulate the inline wire shape. Do not rerun live checks
without a new explicit usage allowance.

## Single automatic adapter: GPT-6.1 Sol comparison

The user subsequently authorized implementation and further testing, without
an opt-in or a user-selectable strategy. A new, independent persistent allowance
bounded this investigation to 72 Responses requests and 6 MiB of serialized
input. Prior exhausted allowances were not reset. Requests used synthetic text,
the public endpoint, existing ChatGPT sign-in, low reasoning, and a 90-second
deadline. No API-key fallback, credential refresh, private session input, paid
automatic retry, explicit-cache configuration or cache warmer was used.

### Repeated-compaction cache controls

`live-experiments/cache.mjs` compared three candidates on `gpt-6.1-sol`. All
used stable per-arm affinity and developer prefixes, appended exact completed
output, and pruned at the latest checkpoint. The 12-step sequence included
stable calls, a tool addition, an inline schema replacement, two padded context
boundaries, a base-schema replacement, removal, and grammar calls.

| Candidate | Requested tool checks | Streamed checkpoints | Input tokens | Cached input tokens |
| --- | ---: | ---: | ---: | ---: |
| Full current namespace snapshot | 12/12 | 8 | 116,454 | 65,536 |
| Stable base with inline updates; refresh after compaction | 12/12 | 8 | 117,173 | 54,272 |
| Keep the old base across compaction, replay current inline tools | 5/6; eliminated at first failed check | 3 | 35,830 | 18,688 |

The full snapshot had better aggregate reuse in this deliberately
compaction-heavy sequence. The stable-base candidate preserved cache on the
addition and inline schema update: 3,712/3,981 and 3,840/4,166 tokens, where
the full snapshot reported zero. Neither is universally cheaper. Retaining an
old base across checkpoints was rejected despite cache gains because the next
compacted request did not produce the requested tool call.

These are sequential synthetic samples, not randomized trials or dollar-cost
measurements. A missing requested call is an observable protocol/task failure,
not direct evidence about the server's internal tool registry.

### Native Pi integration and selected behavior

The first native adapter duplicated the leading declaration in top-level
namespaces and inline history. Its short Pi 1.4 lifecycle checks passed, but a
larger context followed by another compaction failed a requested tool check.
A subsequent short run also omitted a repeated call *without compaction*,
showing that model compliance can confound availability tests.

The final adapter promotes the leading loadout exactly once to top-level
namespaces, retaining all developer instructions and later inline updates.
Tool results now report the actual validated input, and each fixture request
explicitly asks for a new execution instead of treating an earlier result as
sufficient. These changes were not a controlled causal isolation of the earlier
failure; the final end-to-end rerun is the acceptance evidence.

The selected implementation:

- Keeps one stable base across additive updates and inline-only schema changes.
- Rebuilds the base when a base member changes, disappears or becomes hidden.
- Uses Pi's current system/tool checkpoint as a fresh base after compaction.
- Does not carry a private tool catalog through opaque checkpoints.
- Leaves later inline updates and system messages in chronological order.
- Restores legacy checkpoint declarations after the checkpoint when automatic
  adaptation is off or unavailable.
- Fails closed on unknown, ambiguous or oversized tool state.
- Preserves Pi's cache-affinity fields and standard recovery compactor.
- Exposes no strategy flag, snapshot mode or opt-in.

The final long-session acceptance run used Pi 1.4.0 and `gpt-6.1-sol`, with
an 8,000-token test threshold and two separate 650-line synthetic history
expansions. All nine requests passed: fact insertion, a fresh stable call, tool
addition, inline schema replacement, first boundary, subsequent compaction,
second boundary with a grammar call, reload with the latest schema, and recall.
Five Pi checkpoint entries were adopted. A sentinel introduced only in user
history survived the five checkpoints and reload.

A separate final 11-request lifecycle run also passed all ten scenarios:
initial function execution, late addition during compaction, base-schema change
with removal, mode-off/reload, checkpoint branch navigation, hidden-loadout
nested execution, Sol initial/addition checks, a function-to-grammar continuation,
and a fresh disabled session. Nine compaction items were streamed in that run.
The exact-model cases used `gpt-6.1-sol`; the two secondary-model cases used
`gpt-6-sol`.

The complete new allowance consumed **69/72 requests** and **2,128,986/6,291,456
serialized input bytes**, including failed candidates. Aggregate reported usage
was 584,172 input tokens, 12,098 output tokens and 244,480 cached input tokens.
These totals include deliberately failed and compaction-heavy experiments and
are not a production cost estimate. No allowance was silently extended.

| Final native request | Cached / input tokens |
| --- | ---: |
| Stable continuation | 3,584 / 3,836 |
| Tool addition | 3,712 / 4,082 |
| Inline-only schema update | 3,968 / 4,333 |
| First request with the refreshed base | 0 / 19,318 |
| Reloaded continuation | 18,176 / 33,726 |
| Final recall continuation | 33,152 / 33,409 |

Thus measured reuse was about 91–93% on the small stable/addition/schema
continuations and 99% on the final continuation, but not at every boundary.
The test threshold intentionally causes repeated compaction; it is not a
production recommendation. Opaque checkpoint bytes and the provider's reported
input accounting are not exact measurements of the locally active context.

The offline installed-host suite covers multiple epochs, exact schemas and
namespaces, initial promotion, native delta positions, hidden tools, tool
continuations, mode-off/reload/branches, standard recovery, and bounded test
continuations. The packed-load suite can also target the installed bundled host
through `PI_COMPACTION_HOST_ENTRY`, with only declared runtime dependencies and
no physical Pi peers in the candidate directory. It exercises print, JSON and
RPC modes. Static-catalog effort updates are disabled only in that compatible
fixture; separate tests ensure requests containing `configuration_update` are
not opted into automatic compaction.

Codex source `970111f` informed the design, not the transport: its standard
Responses path supplies request-level tools, while Responses Lite uses inline
declarations and its world-state manager emits chronological tool differences.
Its native `RemoteCompactionV2` and history-installation machinery differ from
public in-stream `context_management`. This extension does not copy that
protocol or claim Codex-equivalent runtime behavior.
