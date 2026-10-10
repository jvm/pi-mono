# pi-subs-usage

See AI subscription usage and reset times without leaving Pi. Background polling keeps usage ready for your configured providers; the status bar follows your selected model without starting another query. It uses Pi-managed credentials. Native `openai` temporarily uses Pi's `openai-codex` login when available.

```text
[5h █░░░░░ 19% ↻2h41m | 7d █░░░░░ 20% ↻Tue 07:00]
```

- Five services: Codex, Claude, GitHub Copilot, Z.AI/GLM, and OpenCode Go.
- Provider-native windows and credit usage, not Pi session token estimates.
- Startup preloading, periodic background refresh, instant cached provider/model switching, and a session-local off switch.
- No browser cookies, CLI credential discovery, or separate usage login.

## Install

From npm, after publication:

```bash
pi install npm:pi-subs-usage
```

From this repository:

```bash
pi -e ./packages/pi-subs-usage/index.ts
```

Developed and contract-tested with Pi **1.1.0** and Node.js **>=22.19.0**. The command-safety adapter supports Pi 1.1's internal metadata shape; other Pi release lines or incompatible metadata show `[background auth unavailable]` instead of attempting unsafe auth resolution.

Use Pi's normal `/login` or provider API-key setup, then select a supported model. This package does not add model providers or change inference settings.

Hyper is intentionally not monitored because its provider extension already displays usage. Selecting `hyper` hides this package's status without changing the provider extension's status. Other configured supported providers continue refreshing in the background.

## Provider support

All bars and percentages show **consumed** allowance. A full bar means the included allowance is exhausted; a provider may still allow paid overage.

| Service / Pi provider | What appears | Authentication |
| --- | --- | --- |
| Codex — `openai-codex` | Returned duration-based windows, normally 5h and 7d; matching model-specific windows when supplied | Pi's resolved legacy ChatGPT OAuth bearer and its account ID |
| Native OpenAI — `openai` | Codex account windows, or an unavailable status | Temporary fallback to Pi's `openai-codex` OAuth login, which may use a different account |
| Claude — `anthropic` | 5h, 7d, OAuth-app and selected-model weekly limits when returned; enabled extra-usage cap | Pi's resolved Claude subscription OAuth bearer, not an Anthropic API key |
| Copilot — `github-copilot` | Premium/chat/completion allowances, unlimited indicators, or AI credits according to the response | Original GitHub token from the **same** Pi OAuth grant as the resolved inference token |
| Z.AI/GLM — `zai`, `zai-coding-cn` | Returned Coding Plan model-usage windows; MCP allowance excluded | Pi's resolved regional API key |
| OpenCode Go — `opencode-go` | Rolling 5h, weekly, and monthly windows when returned | Pi's resolved OpenCode API key |

Copilot may return only an absolute credit-use counter; that is displayed as credits used, not as a percentage.

Missing optional windows are omitted. Missing or malformed quota data produces an unavailable status, not zero usage. Copilot negative remaining allowance is reported as overage. OpenCode's API percentages are already on a 0–100 scale: `0.5` means `0.5%`.

### Native OpenAI / Sign in with ChatGPT

Pi's new `openai` login differs from legacy `openai-codex`. The native token is accepted by the public Responses API, but no numerical quota endpoint accepting it has been verified.

Until a native endpoint is available, background monitoring for configured `openai` models uses Pi's `openai-codex` OAuth login for quota reads when that login is available. Selecting `openai` displays that cached usage:

```text
[5h █░░░░░ 19% ↻2h41m | 7d █░░░░░ 20% ↻Tue 07:00]
```

This shows the **Codex login's account quota**, not a verified native OpenAI app allowance. The two Pi logins may use different accounts. The compact status omits subscription names and fallback labels; it does not establish that the accounts match.

Pi resolves and refreshes the Codex login through its normal auth API, including custom credential stores. The fallback works independently of native `openai` authentication, including an OpenAI API key. It does not change the selected model or inference credentials, send native tokens to legacy endpoints, or discover Codex CLI credentials or browser cookies.

Without an eligible Codex login, a matching native Pi OAuth login shows `[native quota unavailable]`; OpenAI API-key auth shows `[subscription auth required]`. A failed Codex refresh clears numerical data instead of reusing a stale token.

Check [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) for native limits. The browser may be signed into a different account. See [OpenAI's account and usage guidance](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## Controls and refresh

| Command | Action |
| --- | --- |
| `/subs-usage` or `/subs-usage refresh` | Refresh all configured supported providers now |
| `/subs-usage off` | Clear the status and stop monitoring for this Pi session |
| `/subs-usage on` | Resume monitoring and preload all configured supported providers |

Monitoring starts automatically in **TUI mode**. Print, JSON, and RPC modes do not resolve quota credentials, fetch usage, or create status timers. There is no agent-callable tool and no quota output is appended to the conversation.

At startup, the extension preloads supported models with non-command credentials in Pi's **configured/available model list**, without executing credential commands. Each provider refreshes every two minutes, even while inactive or while the session is idle, so usage from competing sessions is picked up too. A provider with no configured model is not queried. Newly configured models are discovered on the next poll or manual refresh; removed models are evicted then.

Provider/model changes only select a cached reading. They do not query usage, resolve quota credentials, cancel background work, or reset the polling clock. Agent turns do not trigger extra queries. Countdown text updates every 15 seconds without another HTTP request. Initial loading can appear until the first response arrives; a model not yet in the cache shows `[usage unavailable]`. Normal background refreshes keep the last reading visible while awaiting the next response.

Models with identical effective quota credentials share one HTTP request per cycle, including native OpenAI and Codex when they resolve to the same Codex account. Model-specific auth overrides remain isolated, and Claude/Codex model-specific windows are cached separately. Providers load independently; a slow provider does not prevent others from displaying usage. Each polling cycle has a ten-second budget, including auth resolution, and no immediate retries. Manual refresh joins an in-flight cycle rather than duplicating it.

Reloading, turning monitoring off, or shutting down cancels all pending usage reads and clears the cache. Cached readings are process-local, not shared between Pi sessions or written to disk.

Pi owns credential resolution and OAuth refresh. Account changes are recognized on the next refresh; there is no independent account-change event. Use `/subs-usage` after login/logout if you need an immediate update. A changed credential clears the previous account's meter. Failures clear numerical data rather than leaving an apparently current bar.

Reset times use the local timezone. Resets within 24 hours use a countdown; resets within seven days use weekday/time; later resets use month/day/time. `↻due` means the recorded reset time has passed, **not** that the server has confirmed a fresh allowance.

The extension keeps its text on the existing extension-status line and groups it in square brackets to separate it from adjacent packages' content. It shows only usage, without a subscription-name or fallback prefix. Loading, offline, and error states also omit that prefix. It sets only its own status item and preserves the existing footer and other extension statuses, without patching Pi's renderer. Pi or a custom footer may truncate long lines in narrow terminals.

### Command-backed credentials

Pi 1.1 resolves `!command` API keys and headers synchronously, which can freeze the editor during background polling. This package therefore skips affected models and shows `[command auth unsupported]`. This applies to startup, automatic polls, and manual refreshes; `/subs-usage` does not override it.

The check covers configured provider keys and headers, hidden model-specific headers and overrides, extension-registered configuration, and stored API-key commands. A command header on one model does not disable other models with safe auth. Provider-level commands disable monitoring for that provider's models, conservatively including a configured key command that another credential could supersede. The native OpenAI fallback checks the Codex quota source, not unused native credentials.

Use Pi `/login`, an environment variable, or a literal key in Pi's normal private credential store for usage monitoring. Remove command-backed header overrides too. The extension does not change inference configuration, run commands to warm a cache, or reuse a different model's credentials. Pi's own inference and startup authentication can still execute commands outside this extension.

## Limitations

- Usage endpoints are provider-owned but mostly undocumented and may change without notice.
- Custom/proxy origins are rejected, including a custom origin returned by Pi's auth resolver. Credentials are never sent to a guessed usage host.
- Copilot requires a matching Pi `/login` grant; standalone inference tokens and GitHub Enterprise Server credentials cannot supply its account quota in v1.
- Z.AI global and China keys remain regional. The package does not aggregate team/project scopes or read the ordinary pay-as-you-go GLM providers as Coding Plans.
- Third-party credential stores work where the resolved bearer is sufficient, including the Codex fallback. Copilot and native OpenAI unavailable-status detection require an exact matching login readable through Pi's public stored-credential helper.
- An upstream snapshot can lag actual usage. Session token counts are not substituted for account quota.

## Security and telemetry

Only fixed HTTPS usage endpoints receive the quota source's credentials: each eligible configured supported provider, except for the explicit `openai` → `openai-codex` fallback. **Inactive providers are queried too.** Command-backed configurations are skipped before resolving quota auth; Pi may refresh non-command OAuth logins during these polls. A read-only compatibility adapter inspects Pi's already-loaded configuration and raw credential-store metadata because the public resolver does not expose a command-safety check. Unknown host shapes fail closed. Third-party credential stores must honor Pi's raw-read contract; arbitrary blocking code inside third-party auth implementations is outside this check. Redirects are rejected; responses are limited to 512 KiB. No prompts, files, model responses, or conversations are sent. The extension does not persist credentials or quota snapshots, or log them. Pi may update its own credential store during normal OAuth refresh. No project settings are read directly.

`PI_OFFLINE=1` disables usage reads. Standard repository install/update telemetry is best-effort, once per package version, with a five-second timeout. It sends the package name, version, and platform/runtime/architecture to `https://mocito.dev/api/report-install`, never credentials or usage data. It respects CI, `PI_OFFLINE`, `PI_TELEMETRY=0`, and global Pi `enableInstallTelemetry: false`. Its version marker is the package's only persistent state.

See [SECURITY.md](./SECURITY.md) for the complete trust boundary.

## Research and data sources

Inspired by [CodexBar](https://github.com/steipete/CodexBar), reviewed at commit [`b8c6a1e`](https://github.com/steipete/CodexBar/tree/b8c6a1eb8b0e67754806b9aabe0a0186e201afc9).

CodexBar separates provider fetch strategies from normalized usage windows. Some strategies query OAuth or API-key endpoints; others read CLI state, import browser cookies, scrape web pages, or fall back between sources. This package adopts the provider-specific quota semantics but **not** those external credential-discovery strategies. It uses each model's effective Pi credential, with one explicit temporary exception: native `openai` may use Pi's `openai-codex` login.

| Provider | Read-only source |
| --- | --- |
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` |
| Claude | `GET https://api.anthropic.com/api/oauth/usage` |
| Copilot | `GET https://api.github.com/copilot_internal/user` |
| Z.AI global | `GET https://api.z.ai/api/monitor/usage/quota/limit` |
| Z.AI China | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` |

Contract evidence comes from CodexBar's provider fetchers, plugins, and fixtures; OpenAI's Codex backend client; Pi's provider/auth implementation; and the native OpenAI documentation. Tests use synthetic fixtures, not copied account responses.

Native OpenAI research on 2026-10-10 confirmed that a valid Pi SIWC token succeeded on `GET /v1/models` but received `401 no_matching_rule` on ChatGPT's app-usage endpoint, `/backend-api/wham/usage/chatpass/apps`. No numerical endpoint accepting that token was verified. The temporary Codex fallback addresses this gap without claiming that the two logins or their app-specific limits are equivalent.

## Development

From the repository root:

```bash
npm install
npm run -w packages/pi-subs-usage check
npm test -w packages/pi-subs-usage
npm run -w packages/pi-subs-usage smoke
npm run -w packages/pi-subs-usage pack:dry-run
```

The automated smoke test runs Pi's real loader, auth resolver, TUI lifecycle, provider switches, and command dispatcher with **synthetic credentials and mocked HTTP**. It verifies startup preloading, query-free cached switches, hidden per-model auth overrides, command-auth rejection, and the Codex fallback with an expired login, Pi-managed token refresh, a custom credential store, and logout. It also renders Pi's default footer with adjacent package statuses and the unsupported-auth status at narrow and wide widths in dark and light themes. Regression tests use seven inactive models with a slow command fixture, verify zero command executions on repeated polls, and check auth-file changes and private metadata compatibility. It makes no inference calls and does not establish live access for every provider.

For a visual/live smoke test:

1. Start `PI_TELEMETRY=0 pi -e ./packages/pi-subs-usage/index.ts`.
2. Wait for startup preloading, then select a configured supported provider and compare its bars with the same account's usage page.
3. Switch between configured providers and Claude model families; verify that cached matching windows appear immediately without a loading flash.
4. Leave one provider inactive while another session consumes its allowance. After at least two minutes, switch back and compare its reading with the account's usage page, allowing for upstream reporting delays.
5. Run `/subs-usage off`, then `/subs-usage on`; verify that unrelated statuses remain.
6. Select native `openai`; with a Pi `openai-codex` login, compare the unprefixed usage with that Codex account's quota. Without that login, verify the unavailable status. Confirm that the selected inference provider stays `openai`.
7. Run `/reload` and exit; verify that no duplicate status or polling remains.
8. With a harmless `!command` credential or header on a supported test model, verify `[command auth unsupported]` after startup and `/subs-usage refresh`, with no execution caused by polling. Verify that a non-command model of the same provider still shows its own account's reading. Pi itself may execute a provider key command during its startup checks, so distinguish those from extension polls.

## License

MIT. See [LICENSE](./LICENSE).
