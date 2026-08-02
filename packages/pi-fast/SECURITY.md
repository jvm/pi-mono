# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-fast`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

## Security model

`pi-fast` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

The extension does not read or log prompts, credentials, auth headers, or provider responses. It only inspects the current provider/model identifier and creates an in-memory request payload copy with `service_tier: "priority"` for supported OpenAI Codex models when Fast mode is enabled.

Fast mode is off by default and is never persisted. Models without an advertised Fast tier are not modified. The `priority` tier can increase provider usage, so the footer and toggle notifications make the active state visible.

On startup, the package sends a best-effort install/update telemetry ping to `mocito.dev` once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI. The ping contains only the package name, version, and parsed platform/runtime/architecture from its User-Agent; it does not include prompts, file paths, config values, environment variables, or API keys.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and validation instructions.
