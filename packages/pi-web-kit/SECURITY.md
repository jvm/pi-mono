# Security Policy

## Shared admission and cached finding

HTTP admission is bounded per provider origin and account/header scope using
process-random HMAC identities, never public credential keys. Queue wait counts
toward request deadlines. HTTP 429 cooldowns are bounded; waiting requests
recheck extensions within their original deadline, and no retry is added.
Equivalent misses share transport only within the existing cache/account/options
identity; waiter cancellation is independent. Last-waiter cancellation aborts
shared work. Reload cancellation uses Pi's normal tool cancellation signal.

Cached literal finding does not fetch on a miss. It scans redacted content only,
with bounded terms, excerpts and match counts. It accepts no regex, path or
persistent response handle. Search errors contain bounded transport messages,
not backend response bodies. Validation, policy and cancellation failures are
not converted into successful empty searches.

## Supported versions

Security fixes are provided for the latest released version of `pi-web-kit`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-web-kit` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

`pi-web-kit` sends search queries and fetched URLs to the configured third-party provider. A TinyFish search may send the same query in up to 11 paginated requests to satisfy the requested result limit. When `contextTokens` is explicit, TinyFish also receives the selected result URLs for batched extraction, while Firecrawl may scrape search results. Page content returned by providers is cached in memory for the lifetime of the Pi process, subject to TTL and size limits. API keys are read from environment variables or local config files and are used only for provider requests. Do not commit API keys, tokens, or config files containing secrets.

On startup, `@mocito/install-telemetry` sends a best-effort install/update telemetry ping to the configured telemetry endpoint once per package version unless Pi telemetry is disabled or offline mode is enabled. The ping includes only the package name, version, and parsed platform/runtime/architecture from its User-Agent; it does not include prompts, queries, fetched URLs, file paths, config values, or API keys.

The extension validates URLs before fetch calls and only accepts `http:` and `https:` URLs without embedded credentials. This validation reduces accidental misuse but does not sandbox provider responses or the local Pi process.

Tool results use an allowlisted output schema before publication. Model text and
`structuredContent` share the same 50,000-byte JSON budget and credential masking;
renderer details and progress also mask configured API keys, URL credential
patterns and Basic/Bearer authorization-header values (not ordinary auth prose).
Masking precedes provider snippet cuts, local context budgets, and cached page
range slicing so those boundaries cannot expose fragments of a known credential.
Cached page masking preserves character offsets.
Arbitrary provider metadata, Context7 `rules`, cache keys,
and HTTP failure bodies are excluded. Untrusted per-page error bodies become
generic diagnostics; controlled HTTP status/timeout messages remain useful.
This does not classify all private information in fetched content or sanitize
Pi's stored caller arguments. Do not send secrets in queries or URLs.

Exa, TinyFish and Firecrawl results retain an internal requested-URL association across
canonical redirects. Per-URL failure statuses cannot consume another URL's
content or enter the cache as successful pages. Raw status error details are
not returned to the model; failed or unidentifiable pages use the bounded
fallback/error path.

Exa retrieval notices are model-facing, untrusted provider text. Only bounded
`code`, `message`, and `path` fields are exposed after credential masking;
arbitrary notice details are excluded. `/search` diagnostics use
the local `pi-web-kit:exa-diagnostics` event channel, not model context, files,
or an additional network endpoint. They contain only bounded identifier fields,
finite metrics, and controlled error categories/status codes. Warning messages,
request bodies, raw errors, content, and headers are excluded. Consumers are
responsible for storage and retention if they subscribe to these events.
Known configured API keys are excluded from diagnostic identifiers.

Code search uses only Exa `/search` with fixed Auto and `maxAgeHours: 0`.
Caller-controlled mode, cache/snapshot, synthesis, beta, and Agent overrides
are rejected before a request. No legacy endpoint or cached-content fallback
is used on code-search failure. Metadata-only/text-only results are not
substituted for highlight evidence. Freshness is a provider request policy,
not an independent attestation of the provider's content. A search's required
`purpose` is sent as `objective` in that same API call; it does not start an Agent
run or an additional request. API errors and cancellation do not expose raw
abort reasons, and JSON deadlines remain active until the body is consumed.

All provider API calls reject redirects to prevent forwarding
API keys, custom credential headers or request bodies to another destination.
Normal TLS certificate validation remains
enabled. The manual Exa evaluation is opt-in and uses only fixed public queries;
it sends the documented Dynamic Highlights beta header only in that experiment.
Evaluation results also mask the configured key before context or excerpt cuts.

Text and JSON bodies are streamed through an 8 MiB decoded-byte limit before
parsing, output processing or caching. Advertised oversized bodies are rejected
without consuming them. The request deadline covers body consumption, including
markdown.new fallback. Oversized streams are cancelled; partial content is not
published or cached.

The fetch cache charges complete serialized entries, including keys, titles,
links and any retained metadata, against its 20 MiB budget. The registered tool
does not retain arbitrary provider metadata. Requested TinyFish links are
validated as absolute HTTP(S) URLs without credentials, deduplicated and bounded
before caching; publication also applies a shared link-byte budget and reports
omissions without shortening URLs.

Account scopes use HMAC-SHA-256 with a randomly generated, process-local key.
These are ephemeral cache identifiers, not stored password verifiers; neither
the HMAC key nor its fingerprints are published in tool results.

Explicit Exa freshness requirements are translated into fallback-native controls.
Backends that cannot preserve them are skipped. Cached-only Exa requests do not
trigger live fallbacks. Fallback classification never searches document prose
for error phrases. Search/fetch source identities are preserved under output
limits, and oversized documentation is omitted as complete snippets with counts
and refinement guidance rather than silently cutting code.

All five tool renderers strip terminal control sequences and directional control
characters from untrusted display text before applying theme styling. This
presentation protection does not make fetched content trusted instructions.
Global configuration follows Pi's agent-directory resolver, including
`PI_CODING_AGENT_DIR`; project configuration still requires project trust.

The `web` namespace and read-only/idempotent/open-world annotations are advisory.
They do not approve provider spending, bypass tool hooks, or make an inactive
direct tool reachable from nested dispatch. Project trust, URL validation,
provider request limits and cancellation still apply.

Exposure follows actual native codemode activation, not an exposure setting.
With active codemode, enabled web tools are deferred and remain callable
while undeclared; native tool search can discover and activate them.
With inactive/unavailable codemode, the saved direct selection is restored.
An already manually inactive direct tool is not made callable by deferral.
Removing an already undeclared deferred tool is not an observable disable;
use explicit negative settings, CLI exclusions or the package hard disable.
There is no loader or automatic activation of a discovery tool. A bounded
`web_research` prompt section advertises the available deferred tool names
and native discovery route, without provider data or full schemas.

The effective configuration's `enabled: false` is a hard disable. Explicit
`defaultTools` negative entries also hide the corresponding tools. Hidden
definitions cannot be revived by search, activation, late credentials or
reload. CLI exclusions remain enforced by Pi. Config is checked at startup,
prompt and turn/tool boundaries, and again before execution, so stale handlers cannot
start new requests after a hard disable; already dispatched requests are
not cancelled by a config edit. These controls do not restrict other
extensions, tools, or a trusted project configuration override.

Version 2 branch-local `pi-web-kit:registered-tools` custom entries contain
only the effective exposure enum and bounded arrays of this package's fixed
tool names: known tools, direct selection, last applied declarations and
positive settings. They contain no credentials, provider configuration or
usage data and do not enter model context. Selection bookkeeping distinguishes
automatic undeclaration from an observed manual deactivation. Pi still owns
activation, exclusions and historical declaration updates. Missing/invalid
history or older metadata without selection state uses conservative native
restoration rather than forcing inactive tools active on reload.
