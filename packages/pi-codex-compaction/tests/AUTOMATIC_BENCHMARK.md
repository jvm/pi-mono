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
