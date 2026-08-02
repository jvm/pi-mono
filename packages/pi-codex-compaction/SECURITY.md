# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-codex-compaction`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately through [GitHub Security Advisories](https://github.com/jvm/pi-mono/security/advisories/new) or by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

## Security model

`pi-codex-compaction` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

For supported `openai-codex` models, the extension sends the portion of conversation Pi is about to discard to the OpenAI Codex Responses endpoint over HTTPS, using credentials and provider headers resolved by Pi. It stores the provider-issued opaque `encrypted_content` checkpoint in the local Pi session's compaction details so supported Codex requests can reuse it. The checkpoint is not decoded, printed, or logged.

The extension bounds compaction input and response size, validates the Codex HTTPS endpoint and account claim, honors Pi cancellation, and falls back to standard Pi compaction on authentication, transport, response, or context-limit failures. A bounded textual transcript excerpt remains in the compaction summary so switching to another model or provider does not leave the session with only an unusable Codex checkpoint. The fallback may contain conversation content already present in the local session and is still subject to the user's normal Pi session-file permissions.

The extension never logs prompts, conversation contents, credentials, authorization headers, or raw provider responses. Install/update telemetry is best-effort and sends only package/version/runtime metadata; it can be disabled with `PI_OFFLINE=1`, `PI_TELEMETRY=0`, or Pi's `enableInstallTelemetry: false` setting.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and validation instructions.
