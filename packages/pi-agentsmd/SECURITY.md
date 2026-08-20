# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-agentsmd`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-agentsmd` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

The `/init` command requires the user to trust the project, then checks for an existing `AGENTS.md` file before sending a generation prompt. The `--force` flag permits the active model to update that file. The package does not write the file itself: the active model inspects the repository and writes `AGENTS.md` with the user's existing Pi tool permissions. The prompt treats repository content as untrusted data and tells the model not to read credentials, run project commands, install dependencies, or modify other files during generation.

At startup, `@mocito/install-telemetry` sends a best-effort install/update ping to the configured telemetry endpoint once per package version unless CI, Pi offline/telemetry settings, or `enableInstallTelemetry: false` disables it. It contains only the package name/version and parsed platform/runtime/architecture; it does not include prompts, paths, configuration values, credentials, or provider responses.

Do not commit API keys, tokens, credentials, local settings, or machine-specific paths.
