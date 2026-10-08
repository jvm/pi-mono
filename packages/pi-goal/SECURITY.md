# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-goal`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-goal` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

`pi-goal` stores goal state as custom entries in the current Pi session branch. Goal objectives and usage summaries may appear in local Pi session files and in hidden continuation context sent to the active model. Do not put secrets, credentials, tokens, or private data into goal objectives.

The package does not require API keys and does not read provider credentials. Its model tools can only inspect the current goal, create a new explicitly requested goal when none exists, or mark the current goal `complete`/`blocked`.

On supported Pi runtimes (Pi 1.1.0 or newer), `update_goal` uses Pi's
`model-only` exposure. Codemode discovery and nested dispatch through
`ctx.executeTool()` cannot reach it. A direct update must be the only tool call
in its assistant turn, after the model has inspected verification results.
Older runtimes are unsupported; there is no legacy nested-call fallback.
`get_goal` and `create_goal` remain callable from scripts.

This is a tool-call boundary, not an independent verifier of completion or
blocker evidence. The model remains responsible for that evidence. A trusted
extension can execute arbitrary code with the user's permissions; model-only
exposure is not a sandbox against installed extensions.

On startup, `@mocito/install-telemetry` sends a best-effort install/update telemetry ping to the configured telemetry endpoint once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI. The ping includes only the package name, version, and parsed platform/runtime/architecture from its User-Agent; it does not include prompts, goal objectives, file paths, session data, config values, or API keys. Telemetry writes a local deduplication marker under Pi's agent extensions directory.

Goal objectives are treated as untrusted user-provided task data when continuation context is built. They are JSON-encoded before being embedded in the hidden context message to reduce prompt-injection risk from delimiter-breaking text.

Budget accounting reads finalized usage from the raw current branch, including
context-omitted entries. Its metadata contains only token totals, entry IDs,
timestamps, and aggregate scan diagnostics—not prompts, tool arguments, raw
responses, credentials, or encrypted compaction checkpoints. A session-scoped
idle poll reads the branch leaf ID and scans changed history without making
network requests.

Budgets are best-effort token accounting, not a hard spending or authorization
boundary. Unreported usage cannot be counted, active requests can overrun, and
other extensions can override idle warming decisions. Pause and terminal goal
states stop goal continuation but do not exclude later branch usage; clear or
replace a retained goal before unrelated work.

Automatic goal continuation is proposed at Pi's `agent_before_settle` boundary,
after recovery and queued work, rather than starting a new run from a timer.
Cancelled/error outcomes and failed automatic compaction do not request more
goal work. Budget and provider-limit notices are context-only and do not request
a wrap-up turn. These checks control the goal extension's requests, not Pi's own
recovery, user input, or another trusted extension's continuation.

Explicit activation on creation, resume, startup/reload, and tree navigation
rechecks the current goal, session, branch, pending work, and finalized budget.
Old activations are invalidated on lifecycle changes. An active stored goal can
resume on reload; use `/goal pause` to persist a stop across reloads.
Continuation retains JSON framing for untrusted objectives and refuses stored
objectives beyond the public 4,000-character limit instead of truncating them.
