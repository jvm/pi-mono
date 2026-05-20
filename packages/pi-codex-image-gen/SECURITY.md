# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-codex-image-gen`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-codex-image-gen` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

The extension uses Pi's existing `openai-codex` login to obtain a short-lived JWT. The token is used only for requests to the Codex Responses API and is never written to disk or logged. Do not commit API keys, tokens, or decoded JWT payloads.
