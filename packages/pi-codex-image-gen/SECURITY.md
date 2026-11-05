# Security Policy

## Admission and metadata recovery

Direct/artifact operations share bounded account admission. The queue uses
process-random HMAC identities, snapshots arguments, includes wait time in a
total deadline, and cancels queued requests on shutdown/reload. Originals are
reserved only after admission and before network generation. Cancellation after
dispatch may already consume quota; a queue is not authorization to do more work.

`codex_list_image_artifacts` reads the same validated current-branch records and
bounded private manifests as `/image-artifacts`. It returns byte/count-bounded
metadata, never image bytes or arbitrary file contents. Availability uses
non-following file metadata and is a snapshot, not content validation.
Returned backend metadata is allowlisted and is not proof of pixel properties,
served models, charges, or remaining quota. It is not inserted into Pi usage.

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

The extension implements image-capable ChatGPT OAuth under the provider ID `codex-images`, using the Codex-compatible public OAuth client ID (not a client secret). Pi stores access/refresh tokens in its agent credential store, normally `~/.pi/agent/auth.json`, and coordinates refresh. This is local credential persistence, not encrypted secret storage; protect the agent directory and do not commit it. The extension does not write its own credential files or access the Codex app's credential store. `/logout codex-images` removes only the image login. Existing legacy Pi `openai-codex` OAuth remains a fallback when package-owned credentials are absent; refresh or request failure does not switch accounts. An unresolved owned login also checks Pi's provider-auth configuration status: a configured but unusable credential is an error, not permission to try a different account. This includes a stored API-key credential unsupported by the OAuth-only provider; no credential file is read directly by the extension.

Browser login uses random OAuth state and S256 PKCE. Its callback listener binds only to `127.0.0.1:1455`; the registered redirect URI is `http://localhost:1455/auth/callback`. Loopback HTTP is limited to this local callback. Automatic and pasted callbacks must have the expected origin, path, and state. Pasted input must be the full redirect URL, never a bare authorization code. Invalid callbacks cannot finish login. Listener cleanup runs on success, failure, and cancellation. Login has a ten-minute limit; token requests have a 30-second limit and 64 KiB response bound, with no retries or redirects. Do not paste login URLs into chat or log them.

Authorization/token exchange uses fixed `auth.openai.com` HTTPS endpoints with normal TLS validation. Image requests use only the fixed `https://chatgpt.com/backend-api/codex/responses`, `/images/generations`, and `/images/edits` routes, an honest package User-Agent, and disabled redirects. Responses is the default; Images is explicitly selected and PNG-only. There is no automatic cross-transport fallback. JWT account claims supply a validated routing header only; OpenAI authenticates the token. The extension does not import browser cookies, use the `openai` plan-sharing chat grant, or switch to API-key billing. Backend reports and numeric usage counters are allowlisted. Diagnostic categories use known codes or fixed detail strings, never arbitrary server messages; bounded request IDs reject known credentials and JWT-like values. Token response bodies, raw HTTP error bodies, and auth-resolution errors are not shown. Known image request credentials are redacted from backend text.

Network work has a five-minute deadline and a 100 MiB response bound. Output images are limited to 32 MiB; input images must be regular files and are limited to 20 MiB each and 50 MiB in total. Base64 and actual format signatures are checked. A different supported returned format is retained with its actual MIME/extension, never silently converted or regenerated.

Completed originals and recovery metadata are written before best-effort pixel inspection. Header dimensions admit at most 16,777,216 pixels to a fresh worker using the pinned Photon WebAssembly decoder. The worker has a three-second inspection timeout, cancellation, and a 128 MiB V8 old-generation limit; decoded pixel buffers do not cross its boundary, and it is terminated after every result. The V8 limit is not an absolute process/WASM memory limit. Inspection verifies decoded dimensions against the header and reports measured alpha extrema. Decoder errors, unsupported images, or exceeded limits produce an unverified-output warning, not a second generation or deletion of completed originals. This is not a complete image-security audit; treat images as untrusted content when opening them in other software.

Generated files are created exclusively with user-only permissions. A repeated backend ID or existing destination produces a save warning rather than overwriting that file. Cancellation and stream failures do not trigger automatic generation retries because the remote operation may already have consumed quota.

The inline-delivery tool is `model-only`; Pi blocks nested calls before execution.
The artifact tool uses `codemode` exposure, not an exclusive codemode permission:
other nested tools and explicitly activated direct calls can use it. Tool
discovery does not initiate generation or credential resolution. Both entry
points preserve the same OAuth and backend limits.

The provider exposes no native image models. A native image operation would
be separately callable through `models.generateImages()`, without inheriting
the named tools' approval hooks or exclusions. Such an adapter is deferred;
the generic API is not an alternate route around these tools' restrictions.
Backend counters in `details.usage` are informational and do not establish
metered session usage, remaining quota, or a verified subscription price.

Artifact generation reserves a private random OS temporary directory (`0700`)
and an exclusively created original file (`0600`) before requesting generation.
The opened file descriptor is used for writes; a synced, regular file with the
same inode/device and expected length must remain at the returned path.
Successful originals are retained through script errors, reload, shutdown, and
branch changes; only incomplete reservations are deleted by the extension.
There is no automatic expiry. User/OS cleanup can remove them at any time, so
temporary paths are not durable project assets. `save: "none"` on the artifact
tool still writes this temporary original. Protect or explicitly remove
sensitive images when no longer needed.

The session stores bounded artifact metadata (path, MIME type, byte count, call
ID), not generated bytes, prompts, or credentials. A pre-generation reservation
entry anchors the operation to its source branch. A private `0600` JSON
completion manifest in the reserved directory allows late completions to be
recovered without appending state to an unrelated current branch/session.
Forks and resumes that retain the reservation can recover the same original.
Fallback persistent copies keep the private recovery manifest, but remove any
incomplete temporary original.

`/image-artifacts` exposes the last 20 current-branch paths without reading
image bytes or accessing the network. Manifest reads reject symlinks and
non-regular files, are capped at 8 KiB, and validate the returned metadata and
its reservation call identity. The requested reservation MIME can differ from the
validated completed MIME, because actual-format originals remain recoverable.
Session metadata is validated before recent-image selection or
listing. Recent artifact inputs receive the existing regular-file, signature,
and input-size checks. Explicit display uses Pi's image reader and can resize
or omit un-decodable images without modifying originals.

A failed persistent copy does not remove a committed temporary original. If
the temporary write fails after generation, a successful requested persistent
copy can serve as the artifact; if both are unavailable, the tool reports an
explicit post-generation failure and possible quota consumption, not success
or an automatic retry. Disk or session-store failures cannot guarantee recovery.
Base64 originals do not cross codemode's structured generation-result boundary.

At startup, `@mocito/install-telemetry` sends a best-effort install/update ping to the configured telemetry endpoint once per package version unless CI, Pi offline/telemetry settings, or `enableInstallTelemetry: false` disables it. It contains only the package name/version and parsed platform/runtime/architecture; it does not include prompts, file paths, configuration values, credentials, or provider responses.
