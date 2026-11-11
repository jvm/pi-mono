# Security Policy

## Listing

`scout_list` exposes only the existing public repo allowlist, never origin URLs,
credentials or internal state. It performs no clone/removal/network operation;
existing stale-record pruning still applies. Pages are byte/count bounded and
revision-checked to reject stale continuation. Compact context is explicit and
falls back to full paths if listing is not reachable; it does not grant new
tool access or bypass exclusions.

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

`pi-scout` stores repository records under Pi's agent directory and clones registered repositories into the OS temporary directory. It does not provide web search or content-fetching tools, but registering a Git URL uses `git clone`, and `scout_add` with `refresh: true` uses `git fetch` and a fast-forward-only merge, which may contact the configured remote. Reusing an already registered source makes no network request. Registered repository paths are appended to the system prompt so the agent can inspect them with local file tools.

Direct tool text, structured results and renderer details expose only repository
IDs, names, local paths, optional branches and timestamps—not origin/source
metadata. URL userinfo/query/fragment are not used to infer public clone names.
Git receives arguments without a shell and with an option terminator. Branch
and tag names are validated against Git ref-name rules, must not start with `-`,
and are passed as `--branch=<name>`. Refresh passes no caller input to Git; it
uses the refspec Git recorded at clone time and runs only in a real directory
inside the private clone root that the current user owns. Every network Git call
sets `protocol.ext.allow=never`, so configuration cannot enable command
transports. It also sets `credential.interactive=false` and `core.askPass=true`,
so Git fails instead of prompting for a username or password on the terminal:
Git that implements `credential.interactive` stops before prompting, and older
Git gets an empty answer from `true` instead of reading the terminal. Both work
through `-c`, because `pi.exec` cannot set `GIT_TERMINAL_PROMPT=0`. Credential
helpers still run first. A user-set `GIT_ASKPASS` takes precedence over
`core.askPass` and may still prompt on Git versions without
`credential.interactive`. SSH runs with `ssh -oBatchMode=yes` (through
`-c core.sshCommand`, because `pi.exec` cannot set environment variables), so
passphrase, password and unknown-host prompts fail. A user-set
`GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand` is kept unchanged and may
still prompt. Git runs in the private clone root or the clone, not the project directory.
Git output is discarded and capped at 1 MiB per call on Pi hosts that support
`maxBuffer`; a command stopped at the cap fails. Clone/fetch failures and
timeouts do not echo stderr or remote response bodies.

Sources are limited to Git's native transports: `http(s)`, `ftp(s)`, `git`,
SSH and `file` URLs, scp-like `host:path`, local paths and GitHub shorthand.
Remote-helper sources (`<helper>::<address>`) and URLs with any other scheme are
rejected before Git runs. Git would run a `git-remote-<helper>` program named by
the source, and the source comes from model tool calls; `ext::` and `fd::` can
run commands or use inherited file descriptors. `protocol.ext.allow=never` stays
set as a second barrier. No allowlist is kept: `http::`/`https::` add nothing
over plain URLs, and other helpers can be used by cloning manually and
registering the local path. This also keeps helper addresses, which Scout does
not parse, out of records and the clone configuration.

URL passwords, non-SSH usernames, query strings and fragments are removed from
Scout's persisted records, the `/scout` listing, and the clone's `origin` URL in
`.git/config`, which the agent can read. Records written by earlier versions are
redacted when loaded, including the URL inside a remote-helper source; such
records stay listed but are never reused or refreshed. Their existing clone
configuration is not rewritten. A
refresh of a credential-stripped clone uses Git's credential helpers. This does
not remove caller-supplied origins from Pi's tool-call transcript. Prefer Git's
credential mechanisms to embedding credentials in URLs.

Scout tool calls run sequentially within one Pi dispatcher; atomic state writes
remain separate from clone creation/deletion and are not a cross-process
transaction. Namespaces and behavior hints are not authorization. Registration
can contact remote hosts; removal can delete a clone when explicitly requested.
Normal approval hooks and tool exclusions remain effective.
