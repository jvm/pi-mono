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

On startup, `@mocito/install-telemetry` sends a best-effort install/update telemetry ping to the configured telemetry endpoint once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI. The ping includes only the package name, version, and parsed platform/runtime/architecture from its User-Agent; it does not include prompts, repository sources, clone paths, config values, or API keys.

`pi-scout` stores repository records under Pi's agent directory and clones registered repositories into the OS temporary directory. It does not provide web search or content-fetching tools, but registering a Git URL uses `git clone`, which may contact the configured remote. Registered repository paths are appended to the system prompt so the agent can inspect them with local file tools.

Direct tool text, structured results and renderer details expose only repository
IDs, names, local paths, optional branches and timestamps—not origin/source
metadata. URL userinfo/query/fragment are not used to infer public clone names.
Git receives arguments without a shell and with an option terminator; clone
failures do not echo stderr or remote response bodies. This does not remove
caller-supplied origins from Pi's tool-call transcript, Scout's private records,
the local `/scout` listing, or Git configuration. Prefer Git's credential
mechanisms to embedding credentials in URLs.

Scout tool calls run sequentially within one Pi dispatcher; atomic state writes
remain separate from clone creation/deletion and are not a cross-process
transaction. Namespaces and behavior hints are not authorization. Registration
can contact remote hosts; removal can delete a clone when explicitly requested.
Normal approval hooks and tool exclusions remain effective.
