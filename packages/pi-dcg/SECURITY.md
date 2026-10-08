# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-dcg`.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Report privately through the repository maintainer's GitHub security contact. Include a description, reproduction steps, affected versions, and suggested mitigation when available.

## Security model

`pi-dcg` is a local guardrail bridge, not a sandbox or authorization boundary. Pi extensions execute with the same permissions as the user running Pi, and dcg is a separately installed executable with those permissions.

The bridge:

- intercepts Pi's built-in agent `bash` calls, including codemode and other `ctx.executeTool()` calls, and, by default, user `!`/`!!` commands;
- starts the configured dcg executable directly without a shell;
- sends command text to that local child process on stdin;
- sets the child cwd to Pi's current working directory;
- validates dcg's structured stdout decision;
- seals an approved agent `bash` command and its input reference so later `tool_call` handlers cannot replace them unchecked;
- keeps allow-once commands out of model-visible denial results and shows them only through user-facing UI notifications;
- captures but does not log or forward dcg stderr;
- bounds child output and denial text;
- forwards turn/runtime cancellation to policy checks and confirmation dialogs, blocking even in fail-open mode;
- serializes this extension instance's confirmation dialogs without serializing ordinary policy checks or allowing approvals to carry over to another call;
- preserves hard dcg denials without a one-click bypass.

The child receives Pi's environment because dcg policy is intentionally configured through `DCG_*` variables. `pi-dcg` additionally sets `PI_CODING_AGENT=true`, `DCG_NO_SELF_HEAL=1`, and no-color flags for that child. Environment values are never logged or sent over the network by this package.

### Failure behavior

Bridge failures default to visible fail-open behavior to match dcg's integration philosophy. Set `PI_DCG_ON_ERROR=block` to block when the bridge cannot start dcg, times out, exceeds output limits, receives a nonzero exit, or cannot validate stdout.

This setting cannot detect dcg's internal intentional fail-open paths, which may return a valid allow after size, parse, AST, or deadline fallback. Configure dcg itself for stricter analysis where supported.

Turn abort and runtime shutdown cancel active and queued DCG confirmations. Late UI responses cannot reverse cancellation. Print/JSON sessions without UI block `ask`; RPC clients can answer through the extension UI protocol. This does not extend coverage to RPC control-channel shell commands.

### Pi 1.1.0 composition limits

Command sealing protects against later `tool_call` mutations, not a replacement of the entire input object by an earlier handler. Pi retains the original execution arguments in that case, but DCG sees the replacement. An upstream argument-identity fix is needed before claiming that every possible hook composition executes exactly the checked command. Earlier handlers must mutate argument fields in place.

The confirmation queue is local to one DCG extension instance. Pi's terminal dialog slot is shared across extensions, and another extension's simultaneous dialog can still displace a pending prompt. This does not grant approval to the displaced call, but it can leave that call waiting until cancellation. General dialog scheduling must be fixed in Pi rather than by replacing the bash executor.

The real-session tests record these host limitations explicitly. They are not passing safety guarantees. No global fail-open switch, model-callable bypass, executor replacement, new credential flow, or additional command logging is introduced.

### Known bypasses

The extension cannot intercept arbitrary process creation. Important bypasses include:

- custom tools with other names;
- Pi's RPC control-channel `{"type":"bash"}` command, which does not emit a `user_bash` event;
- `pi.exec()` and child processes started inside another extension;
- non-shell file, database, cloud, or API operations;
- opaque generated scripts and dynamic payloads dcg cannot inspect;
- earlier Pi `user_bash` handlers that fully replace execution;
- dcg rules, packs, safe patterns, allowlists, bypass variables, and fail-open analysis behavior.

Use least-privilege credentials, version control, backups, containers/VMs, and OS-level sandboxing when destructive operations must be prevented rather than merely guarded.

## External dcg dependency and license

`pi-dcg` does not bundle or redistribute Destructive Command Guard. Users install it separately and are responsible for reviewing its code, releases, provenance, and nonstandard license, including its OpenAI/Anthropic rider. This package's MIT license does not apply to dcg.

## Telemetry

On startup, `@mocito/install-telemetry` sends a best-effort install/update telemetry ping to the configured telemetry endpoint once per package version unless disabled by CI, `PI_OFFLINE`, `PI_TELEMETRY`, or Pi's `enableInstallTelemetry` setting. The ping includes only package name/version and platform/runtime/architecture. It never includes commands, paths, dcg decisions, stderr, configuration, environment variables, prompts, credentials, or policy.
