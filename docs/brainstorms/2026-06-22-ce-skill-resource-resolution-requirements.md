---
date: 2026-06-22
topic: ce-skill-resource-resolution
---

# CE skill resource resolution for Pi

## Summary

Make bundled `pi-compound-engineering` skill resources (`references/`, `scripts/`, `assets/`) resolve on the first read attempt with no model inference, by rewriting resource paths in the conversion step so they are correct against the package-root base path that Pi injects — then ship it by bumping upstream CE from 3.13.0 to 3.13.1, the version the package tracks exactly, so the fix actually reaches the installed copy.

---

## Problem Frame

Bundled CE skills carry instructions like "read `references/synthesis-summary.md`." Pi wraps each loaded skill with `References are relative to <baseDir>` and, for package-sourced skills, sets that base to the **package root**, not the skill's own directory. The real files live one level deeper, under `skills/<skill-name>/references/`. So the model must infer and insert the `skills/<skill-name>/` segment, and it reliably does not.

A real session (`/ce-brainstorm` on a mini-class model, 2026-06-18) shows the cost: the skill header stated the correct npm install path, yet the model read four files from `/opt/homebrew/lib/node_modules/@earendil-works/pi-compound-engineering/references/…` — wrong install location, wrong npm scope, and the missing `skills/<skill>/` segment all at once. Four `ENOENT` errors, two `find` searches, then rediscovery and re-reads from the correct path. Roughly nine wasted tool calls, every time a skill reaches its Phase-3 resource loads. A guidance-only fix exists in source (`src/skill-resource-guidance.ts` + a `before_agent_start` hook, commit `8ac54f3`) but was never versioned: it sits under "Unreleased" in the changelog, the installed copy lacks the file and the hook, and the guidance marker appears in zero historical sessions. The fix never reached the runtime.

---

## Key Decisions

- **Fix in the converter, not in Pi core.** Pi exposes no extension hook to override package-skill `sourceInfo.baseDir`, and the addon-only design rule rules out editing Pi core. The converter (`scripts/converter.mjs` → `transformContentForPi`) already does load-bearing rewrites of upstream skill content, so resource-path rewriting belongs there.

- **Adapt to Pi's actual baseDir instead of fighting it.** Pi injects the package root as the base for package skills. Rewriting `references/foo.md` to `skills/<skill>/references/foo.md` makes the path correct *given that base*, rather than trying to change which base Pi uses.

- **Version the release or it does not ship.** The prior guidance fix merged to source without a version bump and never deployed. Any fix must bump the package version and reinstall to reach the runtime.

- **Remove the redundant guidance, do not keep two mechanisms.** Once the converter rewrite makes resource paths resolve deterministically, the system-prompt guidance (`src/skill-resource-guidance.ts` and the `before_agent_start` hook) is dead weight that overlaps the rewrite. The converter is the single source of truth.

- **Bump upstream CE to 3.13.1 as the release vehicle.** The package version tracks upstream exactly (CHANGELOG: "no independent hotfix counter"), so the Pi-specific converter fix rides in the 3.13.1 release rather than a Pi-only hotfix. Upstream `cli-v3.13.1` (published 2026-06-17, verified via the GitHub tags API) is a single `ce-proof` bugfix.

- **Retain the upstream version-coupling and accept its shipping cost.** The no-hotfix-counter coupling is the documented reason the prior guidance fix never deployed. We retain it because it preserves the one-to-one version mapping with upstream CE and keeps the SHA256 structure-check contract intact, and accept that Pi-specific fixes ride upstream releases rather than shipping on an independent Pi hotfix cadence. A future Pi-side hotfix channel is out of scope here but remains an option if the coupling becomes a recurring bottleneck.

---

## Requirements

**Resource resolution**

- R1. Bundled CE skill resource references (`references/`, `scripts/`, `assets/`) resolve to readable paths on the first attempt with no model inference, against Pi's package-root base path.
- R2. Resolution holds both in the deployed install and in the source repo checkout.

**Conversion**

- R3. The conversion step rewrites each skill's local resource references to be correct relative to the package root Pi injects, by prefixing `skills/<skill-name>/`.
- R4. The rewrite changes resource path strings only; every other instruction stays semantically intact.

**Release**

- R5. The fix ships in a versioned release with a package version bump, not only in source.
- R6. The installed copy under Pi's npm `node_modules` reflects the fix after reinstall.

**Upstream bump**

- R11. The upstream CE version is bumped from 3.13.0 to 3.13.1 in all three pin locations: `package.json` version, `src/ce-version.ts` `CE_VERSION`, and `scripts/expected-sha256.txt` (regenerated for the 3.13.1 tarball).
- R12. Skill and agent counts in `src/ce-version.ts` are confirmed or updated against the 3.13.1 tarball by the structure check.
- R13. The package version stays identical to the upstream CE version (the "no independent hotfix counter" rule), with Pi-specific divergence recorded under "Unreleased" in the changelog.
- R14. The `ce-proof` change in 3.13.1 (HITL review loop replaced by one-way publish, #957) is reconciled with ce-brainstorm's Phase 4 "Open in Proof" handoff, which currently routes through that HITL workflow.

**Verification**

- R7. The package verify step fails when any skill resource reference would not resolve against the package root.
- R8. Representative skills (`ce-brainstorm`, `ce-setup`, `ce-plan`, `ce-work`, `ce-code-review`) pass the resolution check.

**Cleanup**

- R9. The redundant guidance mechanism is removed: `src/skill-resource-guidance.ts` is deleted and the `before_agent_start` hook is removed from `extensions/index.ts`.
- R10. No installed copy retains the stale pre-fix extension code after reinstall.

---

## Acceptance Examples

- AE1. Covers R1, R3.
  - **Given:** a CE skill `SKILL.md` containing "Read `references/synthesis-summary.md`", loaded as a package skill.
  - **When:** invoked on a mini-class model in a non-package project.
  - **Then:** the model reads `skills/<skill>/references/synthesis-summary.md` on the first attempt, with no `ENOENT` and no `find`-based rediscovery.

- AE2. Covers R5, R6.
  - **Given:** the fix merged to source.
  - **When:** the package version is bumped and reinstalled into Pi's npm `node_modules`.
  - **Then:** the installed copy's `SKILL.md` files contain the rewritten paths, with no stale pre-fix copy remaining.

---

## Scope Boundaries

- **Outside this fix's identity:** changing Pi core's package-skill `sourceInfo.baseDir` to point at the skill directory. That is the more general "correct" fix, but it violates the addon-only constraint and belongs as a future Pi core improvement, not here.
- **Outside this fix's identity:** resource resolution for non-package skills (global or project). Their base path is already the skill directory; the broader model path-guessing behavior is a separate Pi concern.
- **Deferred to planning:** the exact rewrite mechanics — regex scope, false-positive handling (e.g. prose mentions of `references/` or vendored man-page text that are not resource refs), and whether to rewrite paths inside fenced code blocks.

**Related known gaps (out of scope here; follow-up brainstorm)**

- **Model-tier mapping.** ~15 of 38 skills reference cost tiers (`model: "haiku"`/`"sonnet"`) and are already Pi-aware with a working fallback (omit the override), so correctness is unaffected; the gap is only that no Pi model ID is named for the cheap/mid tiers, so tiered dispatch never actually runs cheap. A converter mapping or per-persona model defaults would close it.
- **Agent registration.** The 43 CE personas ship in `agents/` but are not registered as Pi subagents — the package manifest has no `agents` key, and Pi core has no package-level agents discovery (verified). ce-doc-review and peers therefore embed persona content inline per dispatch. Registering them (the extension calls the `pi-subagents` create API at install/runtime) plus a converter change to dispatch by registered name would make personas first-class, cut per-call prompt bulk, and enable per-persona tiering. This is a larger, separate epic and the natural home for the model-tier mapping above.

---

## Dependencies and Assumptions

- Assumes Pi continues to inject the package root as the base path for package-sourced skills (verified by direct runtime observation across three live sessions, not by a traced code path). If Pi core changes this, the rewrite would over-prefix; requirement R7 guards it.
- Assumes the converter processes skills per-directory with the skill name known (it already does).
- Depends on a version bump plus reinstall to take effect (R5, R6).
- Upstream 3.13.1 changes `ce-proof` from a HITL review loop to a one-way publish (#957). ce-brainstorm's Phase 4 "Open in Proof" handoff currently routes through that HITL workflow, so the bump must verify the handoff still behaves correctly under one-way publish (R14).

---

## Outstanding Questions

- **Deferred to planning:** confirm skill-prefixed relative paths (chosen here for portability across source and install locations) over absolute paths baked at stage time.

---

## Sources and Research

- Reproduction: a `--Users-jmocito-work-tolling-arch--` Pi session dated 2026-06-18 invoking `/ce-brainstorm` on a mini-class model — four `ENOENT` reads against a hallucinated `/opt/homebrew/lib/node_modules/@earendil-works/…` path, followed by `find`-based rediscovery and re-reads from `…/skills/ce-brainstorm/references/`. (Session files live under `~/.pi/agent/sessions`, outside this repo.)
- `packages/pi-compound-engineering/scripts/converter.mjs` — `transformContentForPi`, the existing load-bearing rewrite step where resource-path rewriting belongs.
- `packages/pi-compound-engineering/src/skill-resource-guidance.ts` and `packages/pi-compound-engineering/extensions/index.ts` — the unreleased guidance mechanism (`before_agent_start` hook); present in source, absent from the installed copy.
- `packages/pi-compound-engineering/CHANGELOG.md` — guidance entry under "Unreleased"; current release `3.13.0`.
- Commit `8ac54f3` ("fix(pi-compound-engineering): add CE skill resource guidance") — added the guidance without a version bump.
- Upstream CE `cli-v3.13.1` (published 2026-06-17), verified via the GitHub tags API: a single bugfix, `proof: replace HITL review loop with one-way publish` (#957). Compare: https://github.com/EveryInc/compound-engineering-plugin/compare/cli-v3.13.0...cli-v3.13.1
- Version pin files that 3.13.1 must update: `packages/pi-compound-engineering/package.json` (`version`), `packages/pi-compound-engineering/src/ce-version.ts` (`CE_VERSION`, plus `EXPECTED_SKILL_COUNT`/`EXPECTED_AGENT_COUNT` to confirm), `packages/pi-compound-engineering/scripts/expected-sha256.txt` (tarball SHA256).
- Pi core behavior: directly observed at runtime, the skill wrapper injects the **package root** as the base path for package-sourced skills (`References are relative to <baseDir>` resolves to the package install dir), confirmed across three independent live sessions — the 2026-06-18 tolling reproduction plus two skills observed during this review. The wrapper reads `skill.baseDir`; `skills.js` initializes it to the skill directory, but at runtime it resolves to the package root for package-sourced skills. The precise reassignment was not located in the grepped dist and is treated as observed behavior rather than a traced code path.
