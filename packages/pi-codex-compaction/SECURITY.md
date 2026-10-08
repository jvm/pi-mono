# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-codex-compaction`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.
Report privately through
[GitHub Security Advisories](https://github.com/jvm/pi-mono/security/advisories/new)
or contact the maintainer through GitHub. Include the affected version,
description, reproduction steps, and any suggested mitigation.

## Security model

Pi extensions execute with the permissions of the local user. Install only
trusted packages. This extension enables automatic compaction by default only
for eligible `openai` GPT-5/GPT-6 models on `openai-responses` at the exact
official endpoint `https://api.openai.com/v1`.

It transforms ordinary Pi requests; it does not make direct HTTP inference
requests, register a provider, or use ChatGPT's legacy backend endpoints.
Pi owns TLS, transport limits, cancellation, provider retries, authentication,
and credential refresh. The extension does not copy credentials between
providers or fall back from subscription authentication to API-key billing.

## Checkpoints and local data

Raw `response.output_item.done` items are copied, bounded to 1,024 items and
4 MiB total, and adopted only after matching successful stream completion.
Added/partial items are never treated as checkpoints. Unknown output forms,
missing indices, failed streams, and cancellation leave history intact.
Encrypted checkpoint strings are additionally limited to 2 million characters.
The complete persisted details are bounded to 4 MiB.

The checkpoint and its exact post-checkpoint output suffix are sensitive session
data. Provider encryption does not make the surrounding transcript or suffix
public. Neither is logged or sent through install telemetry.

A domain-separated HMAC-SHA-256 binds replay to the current credential, auth
mode, model, endpoint and headers. The provider-issued, high-entropy bearer
credential and potentially secret headers form the HMAC key material and are
never stored in checkpoint details. Only non-secret routing/auth-mode metadata
is used as the HMAC message. This is
credential binding, not storage or verification of user-chosen passwords.
Rotation invalidates replay, including OAuth token refresh. The fallback is
a bounded transcript excerpt, not a complete summary. The original history and
fallback remain subject to the user's Pi session-file permissions and retention.

Replay checks the canonical retained assistant and serialized output
fingerprints. Omitted, edited, or transformed messages fall back rather than
restoring stale raw content. As with Pi text summaries, edits to already-compacted
source history cannot alter an opaque checkpoint. Legacy checkpoint details are
not migrated or replayed across provider/authentication boundaries.

## Extension composition and recovery

Load this extension after request transformers. Its compatibility check cannot
constrain a later trusted extension that changes the payload. It skips observed
reasoning configuration updates, stateful continuation, truncation, multi-agent
requests, and preexisting compaction policies.

Cache warming is stopped only for a cached request that actually enabled
automatic compaction, because replay could produce an uncommitted checkpoint.
Other providers and skipped requests retain Pi's normal warming behavior.
Turning automatic mode off still blocks warming the old automatic request until
a new ordinary request replaces it.

The extension does not execute tools, duplicate response usage, or issue an
automatic paid retry after a failed attempt. Pi's standard compaction remains
available. Local success diagnostics contain only a version, elapsed
milliseconds, byte count and output-item count.

No project settings are read. Install telemetry is best-effort, once per
version, with a five-second timeout. It sends only package/version/runtime
metadata and respects CI, `PI_OFFLINE`, `PI_TELEMETRY`, and
`enableInstallTelemetry: false`.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for validation and live-test precautions.
