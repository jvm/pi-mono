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

The `/init` command checks for an existing `AGENTS.md` file before generating one. The `--force` flag bypasses this check. The package does not read or write files other than `AGENTS.md` in the current working directory, and does not send data to external services.

Do not commit API keys, tokens, credentials, local settings, or machine-specific paths.
