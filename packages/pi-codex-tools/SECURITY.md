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

`apply_patch` does not access the network or credential APIs. Like Pi's native `edit` and `write` tools, it accepts relative or absolute paths and can modify files outside the current working directory with the local user's permissions. It can read credential-containing files when a patch targets them. It rejects symlink paths and symlinked parents, limits patch input to 1 MiB and target-file reads to 64 MiB, preflights file changes before writing, and performs a filesystem-root-anchored descriptor-based no-follow directory walk so a path component swapped to a symlink between check and use cannot redirect a mutation. On Linux the walk re-opens each component via `/proc/self/fd`; on macOS it uses a bundled `openat`/`mkdirat`/`unlinkat` N-API binding (committed prebuilds for Apple silicon and Intel, loaded via `node-gyp-build`) because Node does not expose `openat` and macOS lacks procfs. The binding is darwin-only, exposes only those POSIX calls, and is loaded best-effort: on platforms without it `apply_patch` fails closed and Pi keeps its native `edit`/`write` tools. A failure during a multi-file write can still leave earlier files changed; callers should use version control and review the resulting diff.

The package strips untrusted C0/C1 control bytes and terminal escape sequences from `apply_patch` preview text and paths before handing them to the TUI. The package reads the current provider/model capability flags only to select tools. It does not log prompts, patches, file contents, credentials, auth headers, or provider responses.

Install/update telemetry is best effort and can be disabled with `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_TELEMETRY=false`, CI detection, or Pi's `enableInstallTelemetry: false` setting. Through `@mocito/install-telemetry`, it sends the package name and version as HTTPS URL query parameters and adds `process.platform`, the runtime name/version, and `process.arch` to the `User-Agent`. These fields are not intended to identify a host, user, repository, or path; no prompts, patches, file contents, credentials, auth headers, or provider responses are sent.
