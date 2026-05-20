# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-web-kit`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-web-kit` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

`pi-web-kit` sends search queries and fetched URLs to the configured third-party provider. Page content returned by providers is cached in memory for the lifetime of the Pi process, subject to TTL and size limits. API keys are read from environment variables or local config files and are used only for provider requests. Do not commit API keys, tokens, or config files containing secrets.

On startup, the extension sends a best-effort install/update telemetry ping to `mocito.dev` once per package version unless Pi telemetry is disabled or offline mode is enabled. The ping includes only the package name, version, and parsed platform/runtime/architecture from its User-Agent; it does not include prompts, queries, fetched URLs, file paths, config values, or API keys.

The extension validates URLs before fetch calls and only accepts `http:` and `https:` URLs without embedded credentials. This validation reduces accidental misuse but does not sandbox provider responses or the local Pi process.
