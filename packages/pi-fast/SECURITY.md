# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-fast`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately through [GitHub Security Advisories](https://github.com/jvm/pi-mono/security/advisories/new) or by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

## Security model

`pi-fast` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

The extension does not read or log prompts, credentials, auth headers, or provider responses. It reads only the `pi-fast.enabledByDefault` value from global Pi settings, inspects the current provider/model/API identifiers and Pi's OAuth status, and creates an in-memory request payload copy for supported models when Fast mode is enabled. It uses `service_tier: "fast"` for `openai` API-key access on `openai-responses`, and `service_tier: "priority"` for ChatGPT OAuth or legacy `openai-codex`. It does not resolve credentials, change provider endpoints, cache authentication, or add probe/retry requests to select a tier.

Fast mode is off by default unless `pi-fast.enabledByDefault` is explicitly `true`. Session toggles are not persisted. Models outside the allowlist are not modified. Fast processing can increase API charges or subscription usage, so the setting is an explicit opt-in and the footer and toggle notifications make the requested state visible. The toggle does not guarantee the server delivers Fast processing, and API token-cost estimates do not establish subscription billing.

Ordinary requests that enable server-side compaction receive the same in-memory
service-tier transform. The obsolete direct-compaction event-bus adapter has
been removed. This does not read the conversation or add a network request.

On startup, `@mocito/install-telemetry` sends a best-effort install/update telemetry ping to the configured telemetry endpoint once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI. The ping contains only the package name, version, and parsed platform/runtime/architecture from its User-Agent; it does not include prompts, file paths, config values, environment variables, or API keys.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and validation instructions.
