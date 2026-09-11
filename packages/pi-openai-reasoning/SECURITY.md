# Security Policy

Security fixes apply to the latest released version.
Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/jvm/pi-mono/security/advisories/new).

## Security model

Pi extensions run with the user's permissions. Install only trusted packages.
This extension transforms in-memory Codex request bodies through documented Pi
hooks. It never reads credentials, adds auth headers, registers a provider or
sends its own inference requests. Pi owns OAuth storage, refresh and transport.
Only the official Codex HTTPS origin and known endpoint paths are supported.

Session custom entries contain bounded effort values, positions and SHA-256
history fingerprints. They contain no prompts, raw reasoning, opaque checkpoints
or credentials. Fingerprints are not encryption: treat session metadata as
private. Imported state is validated before use, and only the active branch is
read. No project settings are read. No prompt or provider data is logged.

The compaction event bus shares request data with installed cooperating local
extensions. Those extensions have the same trust level as Pi itself. Temporary
compaction transforms do not commit reasoning state.

Install telemetry sends only package/version/runtime metadata to
`https://mocito.dev/api/report-install`, once per version, with a five-second
timeout. It respects CI, `PI_OFFLINE`, `PI_TELEMETRY` and the global
`enableInstallTelemetry: false` setting. No tokens or conversation data are sent.
Live smoke tests are explicit opt-in and use the existing subscription.
