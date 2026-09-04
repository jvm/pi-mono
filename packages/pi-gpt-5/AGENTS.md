# pi-gpt-5 Guidelines

Root `AGENTS.md` applies.

## Invariants

- `features_gate.md` is the gating source of truth. `src/features.ts` mirrors
  it; both change in the same commit, never separately.
- Feature lookups go through `featuresFor(modelId)`. No model-id string
  literals at feature call sites.
- Unknown or non-OpenAI models keep the extension fully passive; no request
  fields may be added or rewritten for them.
- Beta features (multi-agent) and usage-increasing features (pro mode, PTC)
  default to off and require explicit per-session opt-in.
- Codex-auth entitlement checks use the backend model catalog; plan-name
  sniffing is forbidden.
- The extension must not read, log, or persist prompts, credentials, or
  provider response data.

## Validation

```bash
npm run -w packages/pi-gpt-5 check
npm test -w packages/pi-gpt-5
npm run -w packages/pi-gpt-5 pack:dry-run
```

After any OpenAI model announcement, re-verify `features_gate.md` rows against
the sources listed there and Pi's model registry before changing gates.
