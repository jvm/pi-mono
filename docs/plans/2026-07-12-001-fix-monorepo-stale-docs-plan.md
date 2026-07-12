---
title: "Fix stale monorepo documentation - Plan"
type: fix
date: 2026-07-12
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Fix stale monorepo documentation

## Goal Capsule

- **Objective:** Correct documentation drift across the pi-mono monorepo so contributor-facing docs match the actual state of the repo.
- **Authority hierarchy:** Repo conventions in `AGENTS.md` and `CLAUDE.md` are authoritative for how things *should* be documented; where reality diverges by necessity (the scoped `pi-goal` name), the docs are amended to record the exception rather than the repo changed to match the docs.
- **Stop conditions:** All units landed; README package table matches `packages/*/package.json` exactly; convention docs contain no superseded version references and acknowledge the scoped-name exception; completed brainstorm carries a resolution marker; `npm run validate` passes.
- **Execution profile:** Documentation- and manifest-only edits. No source code, no dependency bumps, no behavioral change.
- **Tail ownership:** A single PR lands all units together (they are small, related, and touch only docs/manifest).

---

## Product Contract

### Summary

A documentation-accuracy cleanup for pi-mono. The headline fix is the root README's package table, which lists 6 of 8 packages (`pi-agentsmd` and `pi-compound-engineering` are missing). The rest corrects accuracy drift in the package-convention docs (`AGENTS.md`, `CLAUDE.md`), the root manifest author, and one implemented-but-unmarked planning artifact.

### Problem Frame

The monorepo has grown to eight packages, but several contributor-facing documents were last meaningfully updated when it had six. The README's package table was last touched when pi-insomnia was added, and the two packages added since — `pi-agentsmd` and `pi-compound-engineering` — never made it in. Separately, the convention docs state a naming rule and show example version pins that no longer match what the packages actually declare. None of this breaks code; it misleads contributors and reviewers who rely on these docs as the source of truth.

### Requirements

**README accuracy**

- R1. The root README package table lists every package under `packages/`, and each row's description matches that package's `package.json` `description`.

**Convention-doc accuracy**

- R2. The package-naming rule in `AGENTS.md` and `CLAUDE.md` reflects actual published names, including the intentional scoped-name exception (`@mocito/pi-goal`).
- R3. Example version pins and illustrative release tags in the convention and publishing docs are current, not referencing superseded versions.

**Repo hygiene**

- R4. The fully-implemented Pi-0.80 compatibility brainstorm in `docs/brainstorms/` carries a visible resolution status.
- R5. The root `package.json` `author` matches the monorepo's stated author convention (`Jose Mocito`).

### Scope Boundaries

In scope: the root README, the root `AGENTS.md` and `CLAUDE.md`, the root `package.json` author field, and the completed Pi-0.80 compatibility brainstorm.

Out of scope:

- Per-package READMEs — audited and already current (descriptions match their `package.json`).
- The scoped `@mocito/pi-goal` name itself — intentional (npm name conflict; see its CHANGELOG). Docs record the exception; the name stays.
- Code, logic, dependency versions, and package internals.
- Historical plans under `docs/plans/` — decision records by design; left as-is.

#### Deferred to Follow-Up Work

- A docs-lifecycle policy (when to archive vs. mark-resolved planning artifacts, and who owns it). This plan marks one implemented brainstorm; a repo-wide convention is a separate decision.
- Automating a check that the README package table stays in sync with `packages/*/package.json` (e.g., a CI script). Worth doing once, not as part of a correctness fix.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Document the scoped-name exception, do not "fix" pi-goal.** `pi-goal` is `@mocito/pi-goal` by necessity — it was reverted to scoped form due to an npm name conflict (documented in its CHANGELOG). The unscoped `pi-*` rule stays the default; a one-line note records that a scoped name is permitted when the unscoped one is unavailable, citing pi-goal as the live example. Rewriting the rule to pretend all packages are unscoped would contradict the actual published package.
- **KTD2. Refresh example version numbers to current, not make them version-agnostic.** Concrete examples (`^0.80.0` at time of writing) help contributors more than abstract placeholders. Adding "at time of writing" framing signals that the number will drift and is not a pinned contract, so the next bump is obviously expected rather than silently re-stale.
- **KTD3. Mark the completed brainstorm resolved in place; leave historical plans alone.** The Pi-0.80 compatibility brainstorm describes work that is fully landed (all packages now at `^0.80.0`). Adding a resolution marker at its top preserves history while making its implemented status visible. The two `docs/plans/` files are decision records, not pending work, so they stay as-is.

---

## Implementation Units

### U1. Complete the README package table

- **Goal:** The README lists all eight packages accurately.
- **Requirements:** R1
- **Dependencies:** none
- **Files:** `README.md`
- **Approach:** Add rows for `pi-agentsmd` ("Generate AGENTS.md contributor guides for Pi repositories.") and `pi-compound-engineering` ("Compound Engineering for Pi: brainstorm, plan, work, review, and compound."), using each package's `package.json` `description` verbatim. Normalize the table to alphabetical order by package name while doing so — the existing order is already near-alphabetical, so this is low-churn and a natural time to tidy.
- **Patterns to follow:** The existing two-column `| Package | Description |` table format.
- **Test scenarios:** Test expectation: none -- documentation-only change with no behavioral surface.
- **Verification:** Every directory under `packages/*/` has exactly one matching table row, and each row's description equals that package's `package.json` `description`.

### U2. Correct convention-doc drift

- **Goal:** `AGENTS.md` and `CLAUDE.md` naming and version guidance matches reality; root manifest author matches convention.
- **Requirements:** R2, R3, R5
- **Dependencies:** none (parallel-safe with U1)
- **Files:** `AGENTS.md`, `CLAUDE.md`, `package.json`
- **Approach:**
  - In the package-naming rule of both docs, add a one-line note that a scoped name (`@scope/pi-*`) is permitted when the unscoped name is unavailable on npm, citing `@mocito/pi-goal` as the current example. Keep the unscoped form as the default.
  - Replace the `^0.75.4` example devDependency pin with `^0.80.0` (current across all packages), framed as "at time of writing."
  - Refresh the illustrative release-tag examples in the publishing section (e.g., `pi-web-kit@0.1.5`) to current versions, or reframe them as obviously illustrative.
  - Set the root `package.json` `author` to `Jose Mocito` to match the convention (root is private, so no publish impact).
- **Patterns to follow:** Existing prose style and inline-code conventions in both docs.
- **Test scenarios:** Test expectation: none -- documentation and private-manifest change with no behavioral surface.
- **Verification:** No `0.75` references remain in `AGENTS.md` or `CLAUDE.md`; the naming rule mentions the scoped-name exception; root `author` is `Jose Mocito`; `npm run check` is unaffected.

### U3. Mark the implemented Pi-0.80 brainstorm resolved

- **Goal:** Completed planning artifact carries a visible resolution status.
- **Requirements:** R4
- **Dependencies:** none
- **Files:** `docs/brainstorms/2026-07-01-pi-080-package-compatibility-requirements.md`
- **Approach:** Add a short resolution line at the top of the document (matching its existing frontmatter/heading style) recording that the Pi-0.80 compatibility bump landed across all packages, with the resolution date. Leave the body unchanged. Do not alter the historical `docs/plans/` files.
- **Patterns to follow:** The document's existing frontmatter and top-of-file style.
- **Test scenarios:** Test expectation: none -- documentation-only change.
- **Verification:** The brainstorm carries a visible resolution marker; no other planning docs change in substance.

---

## Verification Contract

| Check | Command / action | Applies to |
| --- | --- | --- |
| No source regressions | `npm run check` | All units (docs-only; should be a no-op pass) |
| Package contents unaffected | `npm run pack:dry-run` | All units |
| Full local validation | `npm run validate` | Whole PR |
| README table completeness | Every `packages/*/` dir has exactly one matching table row; descriptions equal `package.json` | U1 |
| No stale version refs | `grep -n "0\.75" AGENTS.md CLAUDE.md` returns nothing | U2 |
| Root author corrected | `package.json` `author` is `Jose Mocito` | U2 |
| Brainstorm resolved | Top of the Pi-0.80 brainstorm shows a resolution marker | U3 |

---

## Definition of Done

**Global**

- All listed documents are edited; no source code is changed.
- `npm run validate` passes.
- README package table matches `packages/*/package.json` exactly (eight rows, descriptions verbatim).
- Convention docs contain no `0.75` references and acknowledge the scoped-name exception.
- Root `package.json` `author` is `Jose Mocito`.
- The completed Pi-0.80 brainstorm carries a resolution marker; historical plans are untouched in substance.
- No abandoned experimental edits left in the diff.

**Per-unit:** each unit's Verification checks pass.
