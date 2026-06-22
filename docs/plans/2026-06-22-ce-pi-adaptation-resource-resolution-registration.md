---
title: CE→Pi adaptation: resource resolution, registration, and 3.13.1 bump
type: fix
date: 2026-06-22
origin:
  - docs/brainstorms/2026-06-22-ce-skill-resource-resolution-requirements.md
  - docs/brainstorms/2026-06-22-ce-subagent-registration-requirements.md
---

# CE→Pi adaptation: resource resolution, registration, and 3.13.1 bump

## Summary

Ship a single `pi-compound-engineering` release that (1) rewrites bundled skill resource paths in the conversion step so they resolve against the package-root base Pi injects, (2) bumps the mirrored upstream CE from 3.13.0 to 3.13.1, removing the now-redundant runtime guidance mechanism, and (3) registers the persona agents as first-class Pi subagents via a manifest entry, gating the conditional personas. The three workstreams share the converter/manifest layer and ride one release.

---

## Problem Frame

Two independent CE→Pi adaptation failures, plus a release-cadence gap that hid a prior fix:

- **Resource resolution.** Package-sourced skills inject the **package root** as the base path, but bundled resources live under `skills/<skill>/references/...`. Models must infer the missing segment and reliably do not — a real `/ce-brainstorm` session (2026-06-18) spent ~9 tool calls on four `ENOENT` reads against a hallucinated `/opt/homebrew/.../@earendil-works/...` path before rediscovering the correct one. A guidance-only fix exists in source (`src/skill-resource-guidance.ts`, commit `8ac54f3`) but was never versioned and never reached the installed copy.

- **Agent registration.** The 43 persona agents under `agents/` are invisible to `subagent action:list` because the package manifest declares `extensions` + `skills` but not `subagents`. `pi-subagents` already scans for a `"pi".subagents` manifest key and loads `.md` agents by `name`+`description` frontmatter — the CE files already match. Twelve of the 43 are "Conditional" personas meant for orchestrator selection, not standalone dispatch.

- **Release cadence.** The package version tracks upstream CE exactly ("no independent hotfix counter"), so a Pi-specific fix can only ship riding an upstream release. Upstream `cli-v3.13.1` (2026-06-17) exists and is a single `ce-proof` bugfix (HITL loop → one-way publish, #957); it is the release vehicle.

---

## Requirements

**Resource resolution**

- R1. Bundled CE skill resource references (`references/`, `scripts/`, `assets/`) resolve to readable paths on the first attempt with no model inference, against Pi's package-root base path.
- R2. Resolution holds both in the deployed install and in the source repo checkout.
- R3. The conversion step rewrites each skill's local resource references to be correct relative to the package root Pi injects, by prefixing `skills/<skill-name>/`.
- R4. The rewrite changes resource path strings only; every other instruction stays semantically intact.
- R5. The package verify step fails when any skill resource reference would not resolve against the package root.
- R6. Representative skills (`ce-brainstorm`, `ce-setup`, `ce-plan`, `ce-work`, `ce-code-review`) pass the resolution check.

**Cleanup**

- R7. The redundant guidance mechanism is removed: `src/skill-resource-guidance.ts` is deleted and the `before_agent_start` hook is removed from `extensions/index.ts`.
- R8. No installed copy retains the stale pre-fix extension code after reinstall.

**Upstream bump**

- R9. The upstream CE version is bumped from 3.13.0 to 3.13.1 in all three pin locations: `packages/pi-compound-engineering/package.json` `version`, `packages/pi-compound-engineering/src/ce-version.ts` `CE_VERSION`, and `packages/pi-compound-engineering/scripts/expected-sha256.txt` (regenerated for the 3.13.1 tarball).
- R10. Skill and agent counts in `src/ce-version.ts` are confirmed or updated against the 3.13.1 tarball by the structure check.
- R11. The package version stays identical to the upstream CE version (the "no independent hotfix counter" rule), with Pi-specific divergence recorded under "Unreleased" in `packages/pi-compound-engineering/CHANGELOG.md`.
- R12. The `ce-proof` change in 3.13.1 (HITL review loop replaced by one-way publish, #957) is reconciled with ce-brainstorm's Phase 4 "Open in Proof" handoff, which currently routes through that HITL workflow.

**Release**

- R13. The fix ships in a versioned release with a package version bump, not only in source.
- R14. The installed copy under Pi's npm `node_modules` reflects all changes after reinstall.

**Agent registration**

- R15. The package `pi` manifest declares a `subagents.agents` entry pointing at `./agents`.
- R16. Every persona agent that should be directly dispatchable appears in `subagent action:list` after install, with no pi-core change, exposing its bare `ce-` name.
- R17. Conditional personas — those self-described as "selected when the diff touches X" and intended for orchestrator selection — are either excluded from direct dispatch or gated so they cannot be invoked pointlessly outside their trigger context, with the chosen handling recorded explicitly.

---

## Key Technical Decisions

- **KTD1 — Fix in the converter, not Pi core.** Pi exposes no extension hook to override the package-skill base path, and the addon-only rule forbids editing Pi core. The converter (`scripts/converter.mjs` → `transformContentForPi`) already does load-bearing rewrites of upstream skill content, so resource-path rewriting belongs there.

- **KTD2 — Rewrite paths to be correct against the package root.** Directly observed at runtime, Pi injects the package root as the base for package-sourced skills. Rewriting `references/foo.md` to `skills/<skill>/references/foo.md` makes the path correct given that base, rather than fighting which base Pi uses.

- **KTD3 — Remove the redundant guidance; do not keep two mechanisms.** Once the converter rewrite resolves paths deterministically, the system-prompt guidance is dead weight. The converter is the single source of truth.

- **KTD4 — Ride the 3.13.1 upstream release.** The "no independent hotfix counter" rule means the Pi-specific converter fix ships in the 3.13.1 release. Rationale for retaining the coupling (preserves the one-to-one version map and the SHA256 structure-check contract) is recorded; a future Pi-side hotfix channel remains an option if the coupling becomes a recurring bottleneck.

- **KTD5 — Register via the manifest, bare `ce-` names.** The `"pi": { "subagents": { "agents": ["./agents"] } }` entry is the supported, addon-only mechanism `pi-subagents` already scans for. The agent files carry no `package:` field, so pi-subagents exposes the bare local name; the `ce-` prefix is the collision defense (no overlap with builtins; package-vs-package clashes resolve first-discovered-wins).

- **KTD6 — Gate or exclude conditional personas; do not silently expose them.** ~12 personas are designed for orchestrator selection. Registering all 43 unconditionally exposes them for mis-dispatch (e.g. `ce-swift-ios-reviewer` on a Python repo). The handling must be explicit.

---

## Implementation Units

### U1. Converter resource-path rewrite

- **Goal:** rewrite each skill's local resource references so they resolve against the package root.
- **Files:** `packages/pi-compound-engineering/scripts/converter.mjs` (extend `transformContentForPi`).
- **Approach:** add a rewrite pass that, per skill directory, prefixes `references/`, `scripts/`, `assets/` bare references with `skills/<skill-name>/`. Resolve the skill name from the directory being processed (the converter already processes per-directory). Match only genuine resource references — handle the false-positive surface (prose mentions of `references/`, vendored man-page text, paths inside fenced code blocks) per the deferred-to-planning mechanics below.
- **Patterns:** follow the existing `transformContentForPi` rewrite style (regex + protective normalizations), matching how the Task→subagent and slash-command rewrites already compose.
- **Test scenarios:**
  - `references/synthesis-summary.md` in `skills/ce-brainstorm/SKILL.md` becomes `skills/ce-brainstorm/references/synthesis-summary.md`.
  - `scripts/check-health` in `skills/ce-setup/SKILL.md` becomes `skills/ce-setup/scripts/check-health`.
  - A prose mention of "references/" not naming a real resource is left unchanged.
  - Paths already containing `skills/<skill>/` are not double-prefixed.
- **Covers:** R1, R2, R3, R4.

### U2. Verify-step resolution check

- **Goal:** the verify step fails when a rewritten resource reference would not resolve.
- **Files:** `packages/pi-compound-engineering/scripts/verify.mjs`.
- **Approach:** after conversion, walk each skill's rewritten references and assert the target file exists under the package root. Fail loudly with the unresolving path on mismatch.
- **Test scenarios:**
  - A deliberately broken reference aborts verify with a clear message.
  - The five representative skills (R6) pass.
  - Guards KTD2 if Pi core ever changes the injected base (over-prefix would fail this check).
- **Covers:** R5, R6.

### U3. Remove the redundant guidance mechanism

- **Goal:** delete the now-dead guidance code and hook.
- **Files:** `packages/pi-compound-engineering/src/skill-resource-guidance.ts` (delete), `packages/pi-compound-engineering/extensions/index.ts` (remove the `before_agent_start` hook and its imports), `packages/pi-compound-engineering/README.md` (drop the "Skill resource guidance" bullet and runtime-note paragraph).
- **Approach:** mechanical deletion; the converter rewrite (U1) supersedes the guidance. Confirm `extensions/index.ts` still typechecks and the `ce-status` command and dependency check still register.
- **Test scenarios:**
  - `npm run check` passes with the file and hook removed.
  - `npm run verify` still passes.
  - No system-prompt guidance marker is emitted at agent start.
- **Covers:** R7.

### U4. Bump upstream CE to 3.13.1

- **Goal:** update the three version pins and confirm structure.
- **Files:** `packages/pi-compound-engineering/package.json` (`version`), `packages/pi-compound-engineering/src/ce-version.ts` (`CE_VERSION`, confirm `EXPECTED_SKILL_COUNT`/`EXPECTED_AGENT_COUNT`), `packages/pi-compound-engineering/scripts/expected-sha256.txt` (regenerate SHA256 for the 3.13.1 tarball), `packages/pi-compound-engineering/CHANGELOG.md` (3.13.1 entry; Pi-specific divergence under "Unreleased").
- **Approach:** fetch the `cli-v3.13.1` tarball, compute its SHA256, pin it; run the structure check to confirm or update the skill/agent counts; record the converter-rewrite and registration entries under "Unreleased" per the CHANGELOG convention ("Pi-specific divergence notes appear under `## [Unreleased]`").
- **Patterns:** the verify script already cross-checks `package.json` version against `CE_VERSION` and asserts the SHA256 — let it drive correctness.
- **Test scenarios:**
  - `npm run verify` passes with version 3.13.1 and the new SHA256.
  - Skill/agent counts match the 3.13.1 tarball.
  - The CHANGELOG's 3.13.1 section names the upstream ce-proof change; the Unreleased section names the converter rewrite + registration.
- **Covers:** R9, R10, R11.

### U5. Reconcile the ce-proof handoff change

- **Goal:** verify the 3.13.1 `ce-proof` change (#957, HITL → one-way publish) does not break ce-brainstorm's Phase 4 "Open in Proof" handoff.
- **Files:** `packages/pi-compound-engineering/skills/ce-brainstorm/references/handoff.md` (read; update only if the handoff text references HITL behavior that 3.13.1 removed).
- **Approach:** diff the 3.13.0 vs 3.13.1 `ce-proof` skill content from the tarballs; trace the handoff's Proof routing against the new one-way-publish behavior. Update the handoff prose only if it instructs HITL-specific steps that no longer exist; otherwise record that the handoff is compatible.
- **Test scenarios:**
  - The handoff's "Open in Proof" option's described behavior still holds under one-way publish, or the prose is updated to match.
  - No reference to a removed HITL step remains.
- **Covers:** R12.

### U6. Register the persona agents via the manifest

- **Goal:** all dispatchable personas appear in `subagent action:list`.
- **Files:** `packages/pi-compound-engineering/package.json` (add `subagents` to the `pi` manifest).
- **Approach:** add `"subagents": { "agents": ["./agents"] }` alongside the existing `extensions` and `skills` entries. The agent files already carry `name`+`description` frontmatter, so no file edits. Confirm bare `ce-` names expose correctly and no builtin collision.
- **Test scenarios:**
  - After reinstall, `subagent action:list` includes the unconditional personas (`ce-coherence-reviewer`, `ce-feasibility-reviewer`, `ce-security-reviewer`, etc.).
  - No builtin agent name is shadowed.
- **Covers:** R15, R16.

### U7. Handle conditional personas

- **Goal:** conditional personas are not silently exposed for mis-dispatch.
- **Files:** TBD by the chosen mechanism (see Open Questions) — likely the converter applying a frontmatter flag pi-subagents excludes, or a name convention, or an explicit Scope Boundaries acceptance. Agent files are upstream-derived, so prefer a converter-applied flag over hand-editing 12 files.
- **Approach:** enumerate the conditional personas (those whose description self-identifies as "Conditional ... selected when..."), then apply the chosen gating. If the mechanism is converter-applied, it composes with U1's rewrite pass in the same conversion step.
- **Test scenarios:**
  - A conditional persona (e.g. `ce-swift-ios-reviewer`) is either absent from direct dispatch, gated behind its trigger, or documented as accepted-mis-dispatch risk — not silently listed as a general reviewer.
- **Covers:** R17.

### U8. Release and reinstall

- **Goal:** ship the versioned release and confirm the installed copy reflects all changes.
- **Files:** release tag `pi-compound-engineering@3.13.1`; reinstall into `~/.pi/agent/npm/node_modules/pi-compound-engineering`.
- **Approach:** run the package's validation (`npm run check`, `npm run verify`, `npm run pack:dry-run --workspace packages/pi-compound-engineering`) before tagging. Use the project-local `/release-package pi-compound-engineering 3.13.1` command per the root AGENTS.md. After release, reinstall and confirm the installed copy has the rewritten skill paths, no guidance file, the `subagents` manifest key, and version 3.13.1.
- **Test scenarios:**
  - `npm run pack:dry-run` includes only intended assets.
  - Post-reinstall, a spot-check skill (e.g. `ce-brainstorm`) resolves a `references/` path on first read with no `ENOENT`.
  - Post-reinstall, `subagent action:list` shows the CE personas.
- **Covers:** R8, R13, R14.

---

## Scope Boundaries

- **Outside this plan:** changing Pi core's package-skill base path (the more general fix, blocked by the addon-only rule); resource resolution for non-package skills; the per-provider model-tier map and dispatch-by-name skill conversion (deferred to a separate requirements doc, where the tier system has a real consumer).
- **Deferred to implementation:** the exact converter rewrite mechanics for U1 (regex scope, fenced-code-block handling) and the exact conditional-persona gating mechanism for U7.

---

## Open Questions

- **U7 mechanism:** which gating mechanism for conditional personas — a converter-applied frontmatter flag that pi-subagents excludes from `action:list` (preferred, composes with U1), a name convention, or explicit acceptance of mis-dispatch risk in Scope Boundaries? Needs a quick check of whether pi-subagents respects any existing "hide from list" frontmatter field before committing.

---

## Risks and Dependencies

- **Pi core base-path behavior is observed, not traced.** The package-root injection is confirmed across three live sessions but the exact code assignment wasn't located in the grepped dist. U2's verify check guards this: if Pi core ever changes the base, over-prefixed paths fail verify loudly.
- **Unversioned coupling on pi-subagents for future tier work.** Not in this plan, but the deferred tier doc will depend on pi-subagents' tool name and `input.model` schema for the `tool_call` injection mechanism.
- **3.13.1 may carry changes beyond ce-proof.** "Single ce-proof bugfix" was verified against the release notes; U4's structure check catches any skill/agent-count drift, and U5 catches handoff drift.
- **Release-cadence dependency.** All Pi-specific changes ride the 3.13.1 release (KTD4); there is no independent hotfix path.

---

## Sources and Research

- Resource-resolution reproduction: `~/.pi/agent/sessions/--Users-jmocito-work-tolling-arch--/2026-06-18T17-47-24…jsonl` — `/ce-brainstorm`, four `ENOENT` reads against a hallucinated `/opt/homebrew/.../@earendil-works/...` path, then rediscovery. (Outside the repo.)
- Pi core behavior: skill wrapper injects the package root for package-sourced skills (directly observed at runtime across three sessions); `agent-session.js` wrapper reads `skill.baseDir`.
- Converter: `packages/pi-compound-engineering/scripts/converter.mjs` `transformContentForPi` (line 367) — the existing load-bearing rewrite step.
- Guidance mechanism (to remove): `packages/pi-compound-engineering/src/skill-resource-guidance.ts` + the `before_agent_start` hook in `packages/pi-compound-engineering/extensions/index.ts`; present in source, absent from the installed copy. Added in commit `8ac54f3` without a version bump.
- Version pins: `packages/pi-compound-engineering/package.json` (`version`), `src/ce-version.ts` (`CE_VERSION`, `EXPECTED_SKILL_COUNT`, `EXPECTED_AGENT_COUNT`), `scripts/expected-sha256.txt`.
- Upstream: `cli-v3.13.1` (published 2026-06-17, GitHub tags API), single bugfix `proof: replace HITL review loop with one-way publish` (#957). Compare: https://github.com/EveryInc/compound-engineering-plugin/compare/cli-v3.13.0...cli-v3.13.1
- Agent registration: `pi-subagents/src/agents/agents.ts` `extractSubagentPathsFromPackageRoot` reads `"pi".subagents`; `loadAgentsFromDir` loads `.md` by `name`+`description`; `buildRuntimeName` returns the bare local name when no `package:` field is set. CE manifest today has no `subagents` key.
- Conditional personas: `packages/pi-compound-engineering/agents/ce-swift-ios-reviewer.md` et al. self-describe as "Conditional ... selected when the diff touches...".
- Origin docs: `docs/brainstorms/2026-06-22-ce-skill-resource-resolution-requirements.md` (R1–R14 there → R1–R14 here), `docs/brainstorms/2026-06-22-ce-subagent-registration-requirements.md` (R1–R3 there → R15–R17 here).
