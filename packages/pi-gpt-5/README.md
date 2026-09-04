# pi-gpt-5

First-class OpenAI GPT-5.x support in Pi. Pi already talks to `gpt-5.6-sol`,
`-terra`, and `-luna`, but the newer reasoning, caching, and hosted-execution
features in OpenAI's GPT-5.6 guidance are not wired up. This package closes
that gap — and gates every feature to the selected model so any OpenAI model
gives a predictable experience.

## What it adds

- **Pro mode** — `reasoning.mode: "pro"` on GPT-5.6 models, with subscription-aware gating (API-key sessions always eligible; Codex-auth sessions verified against the per-account model catalog).
- **Persisted reasoning** — `reasoning.context: all_turns` on 5.6 for better multi-turn continuity.
- **Explicit prompt caching** — `prompt_cache_options` on 5.6 to avoid surprise 1.25x cache-write billing.
- **Programmatic Tool Calling** (planned) — hosted JS orchestration of eligible tools with safe replay of `program`/`program_output` items.
- **Multi-agent beta** (planned) — hosted subagent orchestration behind an explicit per-session opt-in.
- **Model-aware gating** — every feature checks the active model first. `/gpt5` shows exactly what the current model supports.

Feature availability per model lives in [features_gate.md](./features_gate.md), the package's gating source of truth.

## Setup

```bash
pi install npm:pi-gpt-5
```

No configuration required. The extension stays passive on non-OpenAI models.

## Usage

- `/gpt5` — list which GPT-5.x features the current model supports.

Feature toggles ship with the implementation milestones above; see
[CHANGELOG](./CHANGELOG.md) for what is live in your version.

## Compatibility

- Works with the official OpenAI provider in Pi. Third-party gateways work by
  model id but are not individually verified.
- Composes with `pi-codex-tools` (apply_patch grammar tools), `pi-fast`
  (service tiers), and `pi-codex-compaction` (remote compaction); it does not
  replace them.

## Security

See [SECURITY.md](./SECURITY.md). The package never logs prompts, credentials,
or provider response bodies; the entitlement probe sends only authenticated
catalog requests to the Codex backend.
