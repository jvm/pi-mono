# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-codex-tools`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately through [GitHub Security Advisories](https://github.com/jvm/pi-mono/security/advisories/new) or by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

## Security model

Pi extensions execute with the same permissions as the local user running Pi. Review installed extensions and only install packages from sources you trust.

`apply_patch` does not access the network or credentials. It validates paths beneath the current working directory, rejects symlink paths and symlinked parents, limits patch input to 1 MiB and target-file reads to 64 MiB, preflights file changes before writing, and uses root-anchored descriptor-based no-follow operations on Linux/macOS. It fails closed on unsupported platforms because Pi does not provide Codex's OS-level filesystem sandbox. A failure during a multi-file write can still leave earlier files changed; callers should use version control and review the resulting diff.

The package reads the current provider/model capability flags only to select tools. It does not log prompts, patches, file contents, credentials, auth headers, or provider responses.

Install/update telemetry is best effort and can be disabled with `PI_OFFLINE=1`, `PI_TELEMETRY=0`, CI detection, or Pi's `enableInstallTelemetry: false` setting. It sends only package/version and runtime metadata through `@mocito/install-telemetry`.
