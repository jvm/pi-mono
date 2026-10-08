# pi-fast

Use provider fast modes in Pi when you need lower latency, while keeping the paid path off by default.

`pi-fast` requests Fast processing for supported OpenAI models with an API key or a ChatGPT subscription. After you enable it for the session or opt in to the global default, it requests `fast` for API-key access and `priority` for subscription compatibility.

## Features

- **On-demand toggle** — use `/fast`, `/fast on`, `/fast off`, or `Ctrl+Shift+R`.
- **API and subscription support** — use `openai` with either authentication method, or keep a legacy `openai-codex` login.
- **Safe model guard** — only allowlisted models on supported provider/API pairs receive the Fast request field.
- **Visible state** — the Pi footer shows `Fast on`, `Fast off`, or `Fast n/a`.
- **Configurable default** — opt in once to start Fast mode on for every supported model.
- **Session-local overrides** — command and shortcut changes reset to the configured default for each session.

## Supported models

Fast requests are enabled for these models on `openai` (`openai-responses`)
and legacy `openai-codex`:

- `gpt-6.1-sol`
- `gpt-6-astra`
- `gpt-6-sol`
- `gpt-6-luna`
- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.6-terra`

The support list follows the upstream Codex catalog and OpenAI's API Fast documentation. It may need an update when model support changes. Other models are left untouched. Account, region, and plan restrictions still apply.

Checked against the [OpenAI Codex model catalog](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/models-manager/models.json).
GPT-6.1 Sol and all three GPT-6 models advertise `priority` (Fast) processing.
The upstream Codex client defaults Sol and Luna to that tier; `pi-fast`
still requires the session toggle or global opt-in.
Use `/login openai` and select **Sign in with ChatGPT** on Pi 0.99.1 or later.
Pi 0.99.0 introduced this login on the OpenAI provider; 0.99.1 fixed its
bundled login and added GPT-6.1 Sol. Both OpenAI API-key and ChatGPT OAuth
requests use `openai-responses` at `https://api.openai.com/v1/responses`
by default. The extension checks only Pi's OAuth status to select the request
tier; it does not read credentials.
Existing `openai-codex` logins remain supported on Pi 0.85.1 or later.
Pi now labels that provider **OpenAI Codex (legacy)**; its default endpoint
remains `https://chatgpt.com/backend-api/codex/responses`.

### Request tier by authentication

OpenAI's [API Fast documentation](https://developers.openai.com/api/docs/guides/fast-mode)
uses `fast` as the current spelling and accepts `priority` as an equivalent alias.
The extension defaults to the current spelling for API-key access:

| Access | Requested `service_tier` |
| --- | --- |
| `openai` with an API key | `fast` |
| `openai` with ChatGPT OAuth | `priority` |
| Legacy `openai-codex` | `priority` |

Live checks with the new ChatGPT OAuth route rejected `fast` with HTTP 400
(`Unsupported service_tier: fast`), while `priority` completed successfully.
The account catalog advertised Fast as `priority`, so subscription requests
use that spelling directly. The extension checks authentication on each request,
including ordinary requests with server-side compaction, so a change in authentication changes
the requested tier without another toggle. It does not send a rejected request
first or retry it with a different tier.

Those live OAuth checks used GPT-6.1 Sol and GPT-6 Astra on Pi 1.0.0.
Both `priority` requests returned `service_tier: "default"`, so they confirmed
request acceptance, not delivery of Fast processing or a specific usage multiplier.
GPT-6.1 Sol was not listed in that account's model catalog despite successful
inference. No API key was available for live API-key checks; automated tests
cover its Pi transport, and the API `fast` parameter follows the official docs.

### Charges and effective processing

Fast mode can increase API charges or subscription usage. API-key requests use
API pricing; ChatGPT OAuth requests use the authorized ChatGPT plan.
Public API dollar prices and Pi's token-cost estimates are not your ChatGPT credit bill. Consult
[API Fast documentation](https://developers.openai.com/api/docs/guides/fast-mode) and
[Codex speed documentation](https://developers.openai.com/codex/speed)
for rates and availability. The new ChatGPT plan-sharing route does not establish
that its Fast usage multiplier matches legacy Codex.

`Fast on` means the extension requests Fast processing. It does not certify the
tier delivered by the server. OpenAI may return `default` even when `fast` or
`priority` was requested. No latency or billing multiplier guarantee is made.

## Installation

Install from npm:

```bash
pi install npm:pi-fast
```

Install project-locally with Pi's `-l` flag:

```bash
pi install -l npm:pi-fast
```

During local development from this monorepo:

```bash
pi install /path/to/pi-mono/packages/pi-fast
```

For a one-off run without installing:

```bash
pi -e /path/to/pi-mono/packages/pi-fast
```

This is an npm-compatible TypeScript Pi package. There is no runtime build step.
With `pi-codex-compaction` installed, the same Fast toggle applies to ordinary
public OpenAI requests that enable server-side compaction. No separate
direct-compaction event-bus adapter is needed or provided.

## Usage

Start a supported OpenAI model, then use either:

```text
/fast
```

or press `Ctrl+Shift+R`.

`/fast` toggles the current state. `/fast on`, `/fast off`, and `/fast toggle` select it explicitly. When active, supported requests include `service_tier: "fast"` for API keys or `service_tier: "priority"` for subscriptions.

## Configuration

Fast mode remains off by default. To start every session with Fast mode enabled for all supported models, add this setting to Pi's global `settings.json` (normally `~/.pi/agent/settings.json`, or the configured agent directory):

```json
{
  "pi-fast": {
    "enabledByDefault": true
  }
}
```

This is a global opt-in because Fast processing can increase API charges or subscription usage. Unsupported provider/model pairs remain unchanged. `/fast off` disables Fast mode for the current session; starting, switching, or reloading a session restores the configured default.

Install/update telemetry can be disabled with `PI_OFFLINE=1` or `PI_TELEMETRY=0`.

## Development

```bash
npm install
npm run -w packages/pi-fast check
npm test -w packages/pi-fast
npm run -w packages/pi-fast pack:dry-run
```

For repeatable, credential-free coverage against a newer Pi's unmodified
OpenAI provider, pass its installed package directory (Pi 0.99.1 or later):

```bash
npm run -w packages/pi-fast smoke:native-openai -- /path/to/node_modules/@earendil-works/pi-coding-agent
```

This command uses only synthetic in-memory credentials and mocked HTTP. It
checks subscription/API-key tier selection, toggles, and authentication switches
without changing the monorepo's pinned dependencies or making live requests.
It is separate from `test` because the pinned Pi predates native OpenAI OAuth.

Smoke test (Pi 0.99.1 or later): sign in with ChatGPT on `openai`, then
select `openai/gpt-6.1-sol`, enable `/fast on`, and send a short prompt.
Check `Fast on`. Repeat with a legacy `openai-codex/gpt-6.1-sol` login,
and with GPT-6 Astra, Sol, and Luna on both providers.
Switch to an OpenAI API-key session or a different provider and check
`Fast on` for supported OpenAI Responses models and `Fast n/a` for
unsupported provider/API/model pairs. Run `/fast off` and check `Fast off`.
When inspecting responses, distinguish the requested tier from the returned
`service_tier`; a successful request alone does not prove Fast processing.
Check the outgoing request for `fast` with API keys and `priority` with OAuth
or legacy Codex. Change authentication with Fast still enabled and check that
the next request uses the new authentication's tier.
Automated tests use mocked HTTP responses and do not certify live account
access or billing.
