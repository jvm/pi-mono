# Package Guidelines

## Architecture

- `extensions/index.ts` registers lifecycle events and `/subs-usage`.
- `src/monitor.ts` owns a configured-model usage cache, bounded background polling, cancellation, and selected-model status publication.
- `src/auth.ts` resolves each monitored model's effective Pi credential and fixed usage route.
- `src/background-auth.ts` is the isolated, read-only Pi 1.1 compatibility adapter for rejecting configured key/header commands before invoking auth.
- `src/http.ts` bounds read-only HTTP operations.
- `src/parse.ts` normalizes provider-specific quota units; `src/format.ts` renders them.

## Invariants

- Use each model's effective Pi credential except for the documented temporary `openai` → `openai-codex` usage fallback. Resolve that login through Pi and never assume it is the same account.
- Discover configured supported models through Pi's public availability snapshot. Preload at startup and refresh on a fixed background cadence, including inactive providers; selection and agent turns never trigger quota auth or requests.
- Reject command-backed provider keys, provider/model headers, and stored API keys before auth, including manual polls and the Codex fallback. Inspect loaded Pi metadata, not guessed file paths; incompatible private metadata fails closed. Never execute commands to populate an auth cache.
- Resolve every eligible model's effective auth before deduplicating identical usage requests. Hidden model-level overrides prohibit grouping by provider alone. Cache model-specific normalized windows with their original reset times, not credentials or raw responses.
- Native `openai` SIWC is not legacy `openai-codex`; never send the native token to the legacy quota endpoint. No browser or CLI credential discovery is permitted.
- Copilot's original GitHub token is eligible only when its stored Pi grant's access token exactly matches effective inference auth.
- Reject custom origins, auth removals, redirects, oversized bodies, and expired request generations.
- Percentages mean **used**. A missing/reset/failed window is not zero usage.
- Do not monitor Hyper; its provider extension owns its usage display.
- Show only usage or a status message inside the brackets, without a subscription-name or fallback prefix.
- Network strings and raw auth errors must never reach terminal output or sessions.
- Own only the `pi-subs-usage` status key; do not replace the footer or mutate inference.
- Quota monitoring runs only in TUI mode. `/subs-usage off` and `PI_OFFLINE` suppress quota requests.

## Validation

```bash
npm run -w packages/pi-subs-usage check
npm test -w packages/pi-subs-usage
npm run -w packages/pi-subs-usage smoke
npm run -w packages/pi-subs-usage pack:dry-run
```

`smoke` uses Pi's actual loader, auth resolver, TUI event bindings, and command dispatcher with synthetic credentials and mocked HTTP. The entrypoint tests cover all five services, background preloading, query-free provider/model switching, per-model auth isolation, command rejection without subprocess execution, private metadata compatibility, logout/auth changes, cancellation, timing, non-TUI modes, and Hyper exclusion.

For a live visual smoke test, follow README → Development. Provider availability cannot be proved by synthetic fixtures; do not claim otherwise.
