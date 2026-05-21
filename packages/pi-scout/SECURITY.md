# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-scout`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-scout` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

Do not commit API keys, tokens, credentials, local settings, or machine-specific paths.

`pi-scout` stores repository records under Pi's agent directory and clones registered repositories into the OS temporary directory. It does not provide web search or content-fetching tools, but registering a Git URL uses `git clone`, which may contact the configured remote. Registered repository paths are appended to the system prompt so the agent can inspect them with local file tools.
