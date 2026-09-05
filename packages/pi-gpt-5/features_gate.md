# pi-gpt-5 Feature Gate Reference

Single source of truth for gating OpenAI features to the selected model. Every
feature toggle in `src/` reads from `src/features.ts`, which mirrors this file.
When OpenAI changes a capability, update this document first, then
`src/features.ts`, in the same commit.

Scope: OpenAI models on the Responses API (`api.openai.com`). GPT-6 and later
are out of scope until the maintainer has access. Third-party gateways
(OpenRouter, Vercel, Cloudflare) reuse the same gates by model id but are not
individually verified.

## Sources

| Source | Used for | Checked |
| --- | --- | --- |
| Using GPT-5.6 (developers.openai.com/api/docs/guides/latest-model) | 5.6 feature list, parameter contracts | 2026-07 launch docs |
| Reasoning models guide (developers.openai.com/api/docs/guides/reasoning) | efforts, pro mode, `reasoning.context`, `phase` | 2026-07 launch docs |
| Multi-agent guide (developers.openai.com/api/docs/guides/responses-multi-agent) | beta wire contract, restrictions | 2026-07 launch docs |
| Prompting guidance for GPT-5.6 Sol | feature availability notes | 2026-07-09 |
| Pi model registry (`@earendil-works/pi-coding-agent` dist, `compat` + `thinkingLevelMap`) | per-model flags as executed by Pi | verified against installed 0.84.x |
| Codex backend model catalog (`models-manager/models.json`, openai/codex) | `support_verbosity`, catalog-driven gating pattern | openai/codex main, 2026-08 |

Re-verify all rows on every OpenAI model announcement, and whenever Pi's model
registry adds or changes a `compat` flag.

## Legend

- **yes** — send the parameter/feature when enabled.
- **no** — never send; the model rejects it or silently misbehaves.
- **slug** — capability arrives via a separate model id, not a parameter.
- **beta** — server-hosted beta; requires beta header; schema may change.

## Table 1 — Reasoning and lifecycle features

Effort values are the exact wire values each model accepts (verified against
Pi's registry `thinkingLevelMap`; `off` in Pi means "omit the parameter" and is
not listed).

| Model | Efforts | `reasoning.mode:"pro"` | `reasoning.context` all_turns | Default context | `text.verbosity` | Encrypted reasoning replay |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol | none low medium high xhigh max | yes | yes | all_turns | yes (low) | yes |
| gpt-5.6-terra | none low medium high xhigh max | yes | yes | all_turns | yes (low) | yes |
| gpt-5.6-luna | none low medium high xhigh max | yes | yes | all_turns | yes (low) | yes |
| gpt-5.5 | none low medium high xhigh | no | no | current_turn | yes (low) | yes |
| gpt-5.5-pro | medium high xhigh | slug | no | current_turn | no | yes |
| gpt-5.4 | none low medium high xhigh | no | no | current_turn | yes (low) | yes |
| gpt-5.4-mini | none low medium high xhigh | no | no | current_turn | yes (medium) | yes |
| gpt-5.4-nano | none low medium high xhigh | no | no | current_turn | no | yes |
| gpt-5.4-pro | medium high xhigh | slug | no | current_turn | no | yes |
| gpt-5.3-codex | none low medium high xhigh | no | no | current_turn | no | yes |
| gpt-5.3-codex-spark | low medium high xhigh | no | no | current_turn | no | yes |
| gpt-5.2 | none low medium high xhigh | no | no | current_turn | yes (low) | yes |
| gpt-5.2-pro | medium high xhigh | slug | no | current_turn | no | yes |
| gpt-5.1 | none low medium high | no | no | current_turn | no | yes |
| gpt-5 | minimal low medium high | no | no | current_turn | unverified | yes |
| gpt-5-mini | minimal low medium high | no | no | current_turn | unverified | yes |
| gpt-5-nano | minimal low medium high | no | no | current_turn | unverified | yes |
| gpt-5-pro | high | slug | no | current_turn | no | yes |

Notes:

- `minimal` exists only on the original gpt-5 family. `none` arrives with 5.1.
  `xhigh` arrives with 5.2. `max` is 5.6-only. `reasoning.effort` is omitted
  entirely for chat models (gpt-5.2/5.3-chat-latest, gpt-4.x).
- `reasoning.context: "all_turns"` is documented as model-dependent ("only
  supported models accept this value"). Gate it to 5.6 until OpenAI documents
  wider support. The response's `reasoning.context` field echoes the effective
  mode; log it once per session when debugging.
- `text.verbosity` values are low/medium/high. Defaults in parentheses come
  from the Codex backend catalog (the only per-model source OpenAI publishes).
  gpt-5/5-mini/5-nano are marked "unverified": Pi sends `low` there today
  without errors, but no catalog row confirms support.
- With `store: false`, encrypted reasoning items arrive by default now; the
  explicit `include: ["reasoning.encrypted_content"]` Pi sends is accepted but
  no longer required.

## Table 2 — Tools, caching, and transport features

| Model | Explicit prompt cache (`prompt_cache_options`) | PTC (`programmatic_tool_calling`) | Multi-agent beta | Image `detail:"original"` | `phase` on assistant messages | Grammar tools (apply_patch) | Additional tools / tool search | Strict schemas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol | yes | api-key only | beta, api-key only | yes | yes | yes | yes | yes |
| gpt-5.6-terra | yes | api-key only | beta, api-key only | yes | yes | yes | yes | yes |
| gpt-5.6-luna | yes | api-key only | beta, api-key only | yes | yes | yes | yes | yes |
| gpt-5.5 | no | no | no | no | yes | yes | yes | yes |
| gpt-5.5-pro | no | no | no | no | yes | yes | no | yes |
| gpt-5.4 | no | no | no | no | yes | yes | yes | yes |
| gpt-5.4-mini | no | no | no | no | yes | yes | yes | yes |
| gpt-5.4-nano | no | no | no | no | yes | yes | no | yes |
| gpt-5.4-pro | no | no | no | no | yes | yes | yes | yes |
| gpt-5.3-codex | no | no | no | no | yes | yes | no | yes |
| gpt-5.3-codex-spark | no | no | no | no | yes | yes | no | yes |
| gpt-5.2 | no | no | no | no | no | yes | no | yes |
| gpt-5.2-pro | no | no | no | no | no | yes | no | yes |
| gpt-5.1 | no | no | no | no | no | yes | no | yes |
| gpt-5 / -mini / -nano | no | no | no | no | no | yes | no | yes |
| gpt-5-pro | no | no | no | no | no | yes | no | yes |
| gpt-4.1 family, gpt-4o family | no | no | no | no | no | no | no | yes |

Notes:

- Implicit prompt caching with `prompt_cache_key` works for all models; 5.6
  adds explicit breakpoints via `prompt_cache_options.mode: "explicit"` and
  `ttl`, replacing the deprecated `prompt_cache_retention`. Cache writes on 5.6
  bill at 1.25x input; track `cache_write_tokens` when displaying cost.
- PTC: opt eligible tools in with `allowed_callers`; handle `program`,
  program-issued `function_call`, and `program_output` items with `call_id`/
  `caller` linkage preserved on replay. ZDR-compatible, no container cost.
- **PTC auth gate (live-probed 2026-09-04, four request variants)**: the
  Codex backend (`chatgpt.com/backend-api/codex/responses`) rejects the hosted
  tool with `400: Unsupported tool type: programmatic_tool_calling` —
  verified with `OpenAI-Beta: responses=experimental` (pi) and `responses=v1`
  (third-party contract), `originator: pi` and `codex_cli_rs`, with and
  without `client_version`. Re-probe with the payload below when OpenAI ships
  changes; a `200` here means the gate can flip to API-key-or-OAuth.
  PTC remains reachable on `api.openai.com` with an API key (documented;
  not verifiable from this machine — no API key configured).

  Re-probe payload: `POST .../codex/responses` with `stream: true`,
  `store: false`, tools `[{type:"function", name:"get_time", ...,
  "allowed_callers":["programmatic"]}, {type:"programmatic_tool_calling"}]`.

  Context: OpenAI's own subscriber client does not use hosted PTC. Codex CLI
  never sends the tool on any transport; its catalog marks `gpt-5.6-sol`
  `tool_mode: "code_mode_only"` and it implements orchestration as a
  **client-side** V8 runtime (codex-rs `code-mode-*` crates). The only
  community artifact proposing hosted PTC over the Codex OAuth endpoint is an
  open feature request (NousResearch/hermes-agent #99827) that explicitly
  warns not to assume backend support. No working report exists.

  Additional blockers for an extension-only implementation remain: pi's
  Responses parser drops `program` and `program_output` items and
  reconstructs `function_call` field-by-field (dropping `caller`), which
  breaks program resumption mid-loop. PTC requires both a route that accepts
  the tool and an upstream pi parser patch before it can ship.
- Multi-agent: `multi_agent.enabled` + `max_concurrent_subagents` (default 3),
  header `OpenAI-Beta: responses_multi_agent=v1`. Adds `multi_agent_call`,
  `multi_agent_call_output`, `agent_message` items. Unsupported alongside:
  `/responses/compact`, `reasoning.summary`, `max_tool_calls`.
  **Live-probed 2026-09-04**: the Codex backend rejects the parameter
  (`400: Unsupported parameter: multi_agent`, with or without the beta
  header) — same allowlist behavior as PTC. Hosted multi-agent is
  API-key-only today; the subscriber equivalent is Codex's client-side
  subagent orchestration, which is model-agnostic and out of scope for this
  package.
- `detail:"original"` means no downscale to a patch budget. Pinning `original`
  on non-5.6 models sends `high` (Codex's default) instead. Note: the Codex
  backend catalog advertises `supports_image_detail_original` for older models
  too; the API-level guarantee (dimensions preserved with `auto`/`original`)
  is documented for 5.6, so this gate stays conservative.
- Pi's own provider hardcodes `detail:"auto"` on every image part; the
  `imageDetail` pin rewrites those parts on the outgoing payload.
- `phase` (`commentary` / `final_answer`) is documented for 5.5 and 5.4;
  preserve original values when replaying history manually. Pi currently drops
  it at parse time — closing that gap requires a provider patch (tracked in the
  package README roadmap).
- Grammar tools rows mirror Pi's `compat.supportsOpenAIGrammarTools`. The
  apply_patch tool itself is owned by `pi-codex-tools`; this package only
  gates.
- `service_tier` fast/priority toggles are owned by `pi-fast`
  (gpt-5.4, gpt-5.5, gpt-5.6-*). `flex` bills at 0.5x. Not gated here.
- `safety_identifier` is accepted for all models; send it only when the user
  configures an end-user-facing identifier. Off by default.

## Table 3 — Subscription entitlement (Codex/ChatGPT auth only)

Applies when Pi authenticates with a ChatGPT/Codex account rather than an API
key. API-key sessions have no subscription gating: everything in Tables 1–2 is
available.

| Plan | Models | `max` effort | Pro mode | `ultra` (Work) | `ultra` (Codex) |
| --- | --- | --- | --- | --- | --- |
| Free / Go | Terra only (Work/Codex) | yes | no | no | no |
| Plus | Sol, Terra, Luna | yes | no | no | yes |
| Pro | Sol, Terra, Luna | yes | yes | yes | yes |
| Business | Sol, Terra, Luna | yes | yes | no | yes |
| Enterprise | Sol, Terra, Luna | yes | yes | yes | yes |

This table is orientation, not truth at runtime. The backend catalog
(`GET {backend}/models`, authenticated, ETag-cached) carries per-model rows but
— verified against the schema Codex itself consumes — has no pro-mode marker:
`available_in_plans` is unconditional and `supported_reasoning_levels` lists
no `pro` preset. Plan entitlement for `reasoning.mode` is therefore not
discoverable from the catalog.

Gating consequence: API-key sessions are always entitled (standard Responses
API feature). Codex-auth sessions get the toggle with an explicit
"cannot be verified" warning; if the plan rejects the request, the provider
error surfaces in the transcript and the user toggles it off. Plan-name
sniffing is forbidden.

## Gating rules (code contract)

- Out of scope, by design: generic client-side code orchestration (Codex's
  "code mode"). It is model-agnostic, so it belongs in a dedicated extension,
  not here. Only hosted, GPT-5-specific features are gated in this package.

- Model resolution: apply the `gpt-5.6` → `gpt-5.6-sol` alias before lookup.
- Unknown model id (not in `src/features.ts`): stay passive. Never guess.
- All feature lookups go through `featuresFor(modelId)`; no model-name string
  literals at call sites.
- Effort requests: intersect the requested level with `features.efforts`;
  fall back one level down (`max` → `xhigh` → `high`) instead of erroring.
- Pro mode toggle: requires `proMode` AND API-key auth for a silent enable;
  OAuth (Codex) sessions enable with an explicit unverified-entitlement
  warning. Legacy pro slugs (`legacyProSlug`) surface pro capability as a
  model choice, never by sending `reasoning.mode`.
- Beta features (multi-agent): additionally require explicit user opt-in per
  session; never enable by default.
- PTC tool opt-in: read-only, schema-documented tools only. Tools requiring
  approval or returning citations stay direct calls.
