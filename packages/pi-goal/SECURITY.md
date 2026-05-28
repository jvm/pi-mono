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

On startup, the extension sends a best-effort install/update telemetry ping to `mocito.dev` once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI. The ping includes only the package name, version, and parsed platform/runtime/architecture from its User-Agent; it does not include prompts, goal objectives, file paths, session data, config values, or API keys. Telemetry writes a local deduplication marker under Pi's agent extensions directory.

Goal objectives are treated as untrusted user-provided task data when continuation context is built. They are JSON-encoded before being embedded in the hidden context message to reduce prompt-injection risk from delimiter-breaking text.
