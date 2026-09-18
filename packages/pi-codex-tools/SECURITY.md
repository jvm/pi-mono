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

`apply_patch` does not access the network or credential APIs. Like Pi's native `edit` and `write` tools, it accepts relative or absolute paths, follows symlinks for reads/writes, and can modify files outside the current working directory with the local user's permissions. It can read credential-containing files when a patch targets them. Deleting a symlink removes the link, not its referent; moving a symlink source copies its referent's updated content and removes the source link.

The tool uses Node filesystem APIs without a platform-specific native binding. This deliberately replaces the previous no-follow policy with Pi-style filesystem access. Path canonicalization is used for preflight identity and queue keys, not as a security boundary. There is no workspace confinement or protection against another process swapping path components between resolution and I/O. Use an OS-level sandbox or restricted user account when filesystem isolation is required.

Patch input is limited to 1 MiB, hunk count to 1,000, and target-file reads to 64 MiB. Preflight rejects non-file write targets and checks all hunk matches before mutation. Symlink aliases share virtual file state and deduplicated mutation queues. Queues serialize cooperating Pi mutations and remain held until pending I/O settles; they do not lock out other processes. A failure or cancellation during a multi-file write can still leave earlier files changed. Use version control and review the resulting diff.

The package strips untrusted C0/C1 control bytes and terminal escape sequences from `apply_patch` preview text and paths before handing them to the TUI. The package reads the current provider/model capability flags only to select tools. It does not log prompts, patches, file contents, credentials, auth headers, or provider responses.

Install/update telemetry is best effort and can be disabled with `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_TELEMETRY=false`, CI detection, or Pi's `enableInstallTelemetry: false` setting. Through `@mocito/install-telemetry`, it sends the package name and version as HTTPS URL query parameters and adds `process.platform`, the runtime name/version, and `process.arch` to the `User-Agent`. These fields are not intended to identify a host, user, repository, or path; no prompts, patches, file contents, credentials, auth headers, or provider responses are sent.
