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

Subscription requests use the fixed HTTPS `chatgpt.com/backend-api/codex/responses` endpoint with normal TLS validation, an honest package User-Agent, and redirects disabled. The extension does not import browser cookies, change authentication, or switch to API-key billing. Only backend-reported image metadata and allowlisted numeric usage counters are retained; raw HTTP error bodies are not shown. Known request credentials are redacted from backend text.

Network work has a five-minute deadline and a 100 MiB response bound. Output images are limited to 32 MiB; input images must be regular files and are limited to 20 MiB each and 50 MiB in total. Image checks validate base64 and format signatures, not all image internals. Treat images as untrusted content when opening them in other software.

Generated files are created exclusively with user-only permissions. A repeated backend ID or existing destination produces a save warning rather than overwriting that file. Cancellation and stream failures do not trigger automatic generation retries because the remote operation may already have consumed quota.

At startup, `@mocito/install-telemetry` sends a best-effort install/update ping to the configured telemetry endpoint once per package version unless CI, Pi offline/telemetry settings, or `enableInstallTelemetry: false` disables it. It contains only the package name/version and parsed platform/runtime/architecture; it does not include prompts, file paths, configuration values, credentials, or provider responses.
