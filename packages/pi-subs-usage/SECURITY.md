# Security Policy

Security fixes are provided for the latest released version of `pi-subs-usage`.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Report privately through
[GitHub Security Advisories](https://github.com/jvm/pi-mono/security/advisories/new)
or contact the repository maintainer through GitHub. Include affected versions,
reproduction steps, and the security impact.

## Trust boundary

Pi extensions execute with the local user's permissions. Install only extensions
you trust. For eligible non-command configurations this package uses Pi's public
`getApiKeyAndHeaders(model)` resolver and, for the temporary native OpenAI fallback,
`getProviderAuth("openai-codex")`. Pi remains responsible for credential selection,
trusted configuration, and OAuth refresh. The package does not directly read
project configuration, execute processes, or implement its own credential refresh.

Pi 1.1's public resolver can execute configured commands synchronously. An isolated
read-only compatibility adapter checks its already-loaded provider/model configuration,
registered extension configuration, and raw credential metadata before quota auth.
Pi's private `ModelRegistry.runtime`, `ModelRuntime.config`/`credentials`, and
`AuthStorage.readLatestData` are needed because public auth resolution hides these
inputs or executes them. No host methods or configuration are patched. Unsupported
Pi release lines and incompatible private shapes fail closed with a fixed status.
This contract is covered by real-host regression and render/smoke tests.

Configured `!command` provider keys, provider/model headers, and stored API keys
are skipped with `[command auth unsupported]`, even on manual refresh. Provider
key commands are conservatively rejected even if another credential could override
them. A model-specific command does not disable safe models of that provider.
No command result is warmed, cached, or borrowed from another model. Checks use
the live runtime/store rather than independently discovering credential files.
Third-party stores must honor Pi's raw credential-read contract; arbitrary blocking
code in third-party auth/store implementations is not sandboxed or prevented.
Pi's own startup checks and inference can still execute credential commands.

Monitoring discovers supported models through Pi's public available-model snapshot.
It resolves eligible credentials and queries their accounts at startup and periodically,
even when another provider, an unsupported provider, or no model is selected.
Consequently Pi may refresh inactive OAuth logins, but command-backed auth is skipped.
No credential stores or project files are scanned to discover providers.

Each monitored model's origin and any resolved-auth origin must match the provider's
fixed HTTPS allowlist. Explicit auth removals and conflicting authentication
headers fail closed. Requests forward only the required bearer/GitHub token,
validated Codex account ID, and fixed protocol headers. They never forward arbitrary
Pi headers. Account IDs decoded from legacy JWTs are routing metadata, not locally
verified identity claims; authentication is enforced by the provider.

Copilot's usage API needs the original GitHub token, not its inference token.
Only the stored Pi grant whose access token exactly matches effective inference
authorization can provide it. Enterprise Server credentials are not forwarded to
github.com.

When monitoring configured `openai` models, the package temporarily uses an available
Pi `openai-codex` OAuth login for quota reads. Its provider and resolved-auth
origins must also match the Codex allowlist. Only Pi-resolved OAuth is eligible;
raw stored tokens are never used to bypass a failed refresh. The compact display
omits subscription names and fallback labels. These figures may belong to a
different account and do not establish the native app's allowance; see README's
native OpenAI section. This is the only cross-provider fallback.
The selected inference provider and its credentials remain unchanged. Native
OpenAI tokens are never sent to legacy ChatGPT endpoints. No CLI credentials,
browser cookies, or separate usage login are discovered.

All quota traffic uses fixed read-only GET routes documented in README. Redirects
are rejected; each polling cycle is bounded to ten seconds and HTTP bodies
to 512 KiB. A timed-out Pi resolver may finish its own refresh, but its late result
cannot trigger a quota request. No inference probes, billing mutations, allowance
changes, reset redemption, or automatic retries are performed.

Provider/model changes only display cached readings; they do not query, resolve
quota auth, or cancel background work. Reload, shutdown, monitoring off, and offline
checks cancel pending work. Stale generations cannot publish results. Each eligible model's
effective auth is resolved before request deduplication: provider identity alone
cannot safely identify an account when model-specific auth overrides exist.
Only identical requests share a quota response, including the Codex/native fallback.
At most one worker per supported provider runs in parallel.

Request-identity digests prevent reusing an earlier account's meter once changed
auth is resolved. Account/configuration changes are observed on the next poll or
manual refresh, not immediately on a model switch. Removed models are evicted then.
Unchanged accounts keep the last reading while the next read is in flight;
failed reads clear their numerical data without clearing other providers' caches.
Window labels and error messages are locally controlled; raw server strings,
account identifiers, auth errors, credentials, prompts, and conversations are never
displayed or logged.

Only normalized model-specific snapshots and identity digests survive a poll.
Raw responses and request credentials are not cached between polls. These values
stay in process memory and are not appended to Pi sessions or persisted. Each Pi
process has its own cache and polling loop. Monitoring operates only in TUI mode and
respects `PI_OFFLINE`. A native OpenAI usage-settings link is documentation only;
the package neither opens a browser nor assumes that its login matches Pi.

## Install telemetry

`@mocito/install-telemetry` reports one successful install/update per package
version to `https://mocito.dev/api/report-install`, using a five-second timeout.
The report contains package name/version and platform/runtime/architecture from
the User-Agent, not provider credentials, usage, prompts, paths, or settings.
It respects CI, `PI_OFFLINE`, `PI_TELEMETRY`, and global Pi
`enableInstallTelemetry: false`.

The extension directly persists only telemetry's package-version marker in Pi's
agent directory. Pi may update its own credential store during OAuth refresh.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for validation instructions.
