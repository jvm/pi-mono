---
date: 2026-06-22
topic: ce-subagent-registration
---

# CE subagent registration

## Summary

Register the Compound Engineering persona agents as first-class Pi subagents via a one-line package manifest entry, deciding explicitly which personas are safe to expose for direct dispatch. The per-provider model-tier map originally bundled into this work is deferred — it has no in-scope consumer until skills dispatch by registered name, so it rides with that conversion in a separate requirements doc.

---

## Problem Frame

The `pi-compound-engineering` package ships 43 persona agents under `agents/` (reviewers, researchers, strategists), but none are registered as Pi subagents. `subagent action:list` shows only builtins, and the CE skills that dispatch personas (`ce-doc-review`, `ce-code-review`, `ce-plan`, `ce-sessions`, `ce-ideate`, `ce-simplify-code`) must therefore embed the full persona content inline on every dispatch — the pattern used in the ce-doc-review pass that produced this brainstorm, where each of five reviewers received the persona + output contract + document in the task string.

`pi-subagents` already discovers package-contributed agents: it scans installed npm packages for a `"pi-subagents"` or `"pi".subagents` manifest key (`agents.ts` `extractSubagentPathsFromPackageRoot`), then loads any `.md` whose frontmatter has `name` + `description` (`loadAgentsFromDir`). The CE package's agent files already match that format exactly. They are invisible only because the package manifest declares `extensions` and `skills` but not `subagents`.

Registration is independently valuable regardless of how dispatch evolves: personas become discoverable and dispatchable by name, and the `ce-` prefix is the natural namespace for them. The broader CE→Pi dispatch experience (dispatch-by-name, per-provider model tiers) is a separate workstream — see Scope Boundaries.

---

## Key Decisions

- **Register via the manifest, not a programmatic API.** The `"pi": { "subagents": { "agents": ["./agents"] } }` manifest entry is the supported, addon-only mechanism `pi-subagents` already scans for. No pi-core change, no install-time registration hook.

- **Registration relies on the bare `ce-` runtime name as the collision defense.** The agent files carry only `name` + `description` frontmatter (no `package:` field), so pi-subagents exposes the bare local name (e.g. `ce-coherence-reviewer`), not a namespaced one. There is no collision with the builtin agents today, and the `ce-` prefix is CE-specific; package-vs-package clashes resolve first-discovered-wins per pi-subagents' discovery order.

- **Defer the per-provider model-tier map.** The tier system keys off identifying the dispatched agent by name, but the skills embed personas inline today (no name in the dispatch), and converting them to dispatch-by-name is a separate workstream. Shipping the tier machinery now would be dormant code; it rides with the dispatch-by-name conversion in a separate doc, where it has a real consumer.

---

## Requirements

- R1. The package `pi` manifest declares a `subagents.agents` entry pointing at `./agents`.
- R2. Every persona agent that should be directly dispatchable appears in `subagent action:list` after install, with no pi-core change, exposing its bare `ce-` name.
- R3. Conditional personas — those self-described as "selected when the diff touches X" (e.g. `ce-swift-ios-reviewer`, `ce-julik-frontend-races-reviewer`, `ce-data-migration-reviewer`) and intended for orchestrator selection, not standalone dispatch — are either excluded from direct dispatch or gated so they cannot be invoked pointlessly outside their trigger context. The chosen handling is recorded explicitly rather than left implicit.

---

## Acceptance Examples

- AE1. Covers R1, R2.
  - **Given:** the package reinstalled with the manifest entry.
  - **When:** `subagent action:list` runs.
  - **Then:** the unconditional personas (e.g. `ce-coherence-reviewer`, `ce-feasibility-reviewer`, `ce-security-reviewer`) appear as executable agents under their bare `ce-` names.

- AE2. Covers R3.
  - **Given:** `ce-swift-ios-reviewer` is a conditional persona intended only for diffs touching Swift.
  - **When:** it appears in the agent surface.
  - **Then:** it is either absent from direct dispatch, gated behind its trigger condition, or documented as accepted-mis-dispatch risk in Scope Boundaries — not silently exposed as if it were a general-purpose reviewer.

---

## Scope Boundaries

- **Deferred to a separate requirements doc — dispatch-by-name conversion + per-provider model tiers.** Converting the ~6 dispatching skills from inline persona embedding to dispatch-by-registered-name is what activates the per-provider tier→model map (`haiku`→`glm-4.7`, `sonnet`→`glm-5.2` under `zai`, etc., owned by `pi-compound-engineering` config, not pi-subagents). That map keys off the dispatched agent's name, so it has no consumer until the conversion lands; shipping it now would be dormant. That future doc carries the open mechanism question (the CE extension would inject the resolved model via a `tool_call` hook mutating `event.input.model`), the stale-model-ID validation requirement, and the config-schema decisions.
- **Outside this work's identity:** editing the agent files. Registration reads existing frontmatter as-is; tier-on-persona (if ever wanted) belongs with the deferred tier work.
- **Deferred to planning:** the exact mechanism for R3's conditional-persona gating (a frontmatter flag pi-subagents excludes, a name convention, or explicit acceptance), and the enumeration of which of the 43 personas are conditional vs unconditional.

---

## Dependencies and Assumptions

- Assumes `pi-subagents` continues to scan installed npm packages for the `"pi".subagents` manifest key and to load `.md` agents by `name`+`description` frontmatter (verified in `pi-subagents/src/agents/agents.ts`).
- Assumes no other installed package contributes a `ce-` agent name; the prefix is the collision defense, and clashes resolve first-discovered-wins.
- Depends on a version bump + reinstall for the manifest entry to reach the installed copy — the same release-cadence constraint recorded in the sibling resource-resolution requirements doc.

---

## Sources and Research

- `pi-subagents` agent discovery: `src/agents/agents.ts` `extractSubagentPathsFromPackageRoot` reads `"pi-subagents"` or `"pi".subagents` manifest keys; `loadAgentsFromDir` loads `.md` with `name`+`description` frontmatter; `collectPackageRootsFromNodeModules` scans `~/.pi/agent/npm/node_modules`. `buildRuntimeName` returns the bare local name when no `package:` frontmatter field is set.
- CE manifest today: `packages/pi-compound-engineering/package.json` declares `"pi": { "extensions": ["./index.ts"], "skills": ["./skills"] }` — no `subagents` key.
- Conditional-persona evidence: agent files such as `agents/ce-swift-ios-reviewer.md` self-describe as "Conditional ... selected when the diff touches Swift files," indicating orchestrator-selected rather than standalone-dispatch design.
- Sibling doc: `docs/brainstorms/2026-06-22-ce-skill-resource-resolution-requirements.md` notes this work as a related known gap in its Scope Boundaries; both touch the CE→Pi adaptation layer.
- Deferred-tier grounding (for the future doc): `pi-subagents/src/runs/shared/model-fallback.ts` has no tier concept (`resolveModelCandidate` passes `provider/id` strings through unvalidated); the `tool_call` extension hook with mutable `event.input` (pi-core `extensions/types.d.ts`) is the viable model-injection mechanism for the future tier work.
