# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-insomnia`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-insomnia` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

Do not commit API keys, tokens, credentials, local settings, or machine-specific paths.

On macOS, the extension starts the system-provided `/usr/bin/caffeinate` helper while the Pi agent is working. It does not request elevated privileges, pass user prompts to the helper, or run shell commands. The helper is started directly with fixed arguments and is terminated when the agent becomes idle or the Pi session shuts down.

On startup, the extension sends a best-effort install/update telemetry ping to `mocito.dev` once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI. The ping includes only the package name, version, and parsed platform/runtime/architecture from its User-Agent; it does not include prompts, file paths, config values, environment variables, or API keys.
