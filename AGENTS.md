# Repository Guidelines

## Scope and precedence

`pi-mono` contains independently published Pi packages under `packages/*`.

Source of truth, highest first:

1. Executable config: `package.json`, tests, CI, release workflows.
2. Root `AGENTS.md`: monorepo invariants.
3. Package `AGENTS.md`: package-only invariants and exceptions.
4. README: user-facing product, setup, and usage.
5. CHANGELOG: released behavior.

Package instructions must not repeat root policy. If guidance conflicts with executable config, fix the stale guidance in the same change.

## Required workflow

1. Read affected package `AGENTS.md` and inspect worktree/branch.
2. Map impact across package-local, cross-package, and root artifacts before editing.
3. Keep changes scoped; update tests with behavior.
4. Update user docs only when triggers below apply.
5. Run validation from the matrix.
6. Inspect `git diff --check`, `git diff --stat`, and packed files when publishing changes.

Impact scan includes root README/index, `AGENTS.md`, root manifest/lockfile, shared scripts/templates, workflows, release metadata, and security policy. Update only artifacts affected by the change; keep package listings, versions, commands, and policy synchronized.

Bug fixes require regression coverage of the broken integration path. Helper-only tests are insufficient when removing feature wiring would still pass. Private Pi API patches require render/contract tests and a documented smoke test when automation cannot cover runtime behavior.

## Package contract

New packages should copy canonical config files from `templates/package/`, then add only needed resources (`extensions/`, `skills/`, `prompts/`, `themes/`). Every package requires:

- `package.json`, `tsconfig.json`, `.editorconfig`, `.gitignore`
- `AGENTS.md`, `README.md`, `CHANGELOG.md`
- `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `LICENSE`, `SECURITY.md`

Do not create `CLAUDE.md`; only Claude Code owns that file. Do not publish tests, plans, agent files, generated builds, secrets, settings, or machine paths.

### Identity and manifest

- Prefer unscoped `pi-*`; scoped names only when unavailable (`@mocito/pi-goal`).
- Use purpose-specific names, ESM, author `Jose Mocito`, Node `>=20.6.0`, and MIT unless third-party obligations require another license.
- Extension packages expose root `index.ts`, re-export `./extensions/index.js`, and set `pi.extensions` to `./index.ts`.
- Required scripts: `check`, `typecheck`, `test`, `pack:dry-run`.
- Required keywords: `pi-package`; extension packages also use `pi-extension` and `pi`.
- Keep Pi imports in peer dependencies at `*` and pinned dev dependencies. Synchronize shared dev dependency versions.
- Use root `package-lock.json`; never package-local lockfiles.
- Keep `files` explicit. Base list: `index.ts`, `extensions`, `src`, README, LICENSE, CHANGELOG, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT. Add only runtime assets.

Run `npm run validate:packages` after manifest, package structure, telemetry, root index, or shared dependency changes.

### Runtime invariants

- Prefer documented Pi APIs. Isolate and test unavoidable private API use.
- Read project config only when `ctx.isProjectTrusted()`.
- Guard terminal APIs with `ctx.mode === "tui"`; preserve claimed print/JSON/RPC behavior.
- Use `CONFIG_DIR_NAME` where Pi config directory naming matters.
- Compose with existing editors/hooks instead of replacing unrelated extension behavior.
- Bound network/process/tool output and never expose credentials.

### Install telemetry

Publishable extension packages use `src/install-telemetry.ts` and call `reportInstallTelemetry()` first in `extensions/index.ts`. It must be best-effort, once per version, use a 5-second timeout, and respect CI, `PI_OFFLINE`, `PI_TELEMETRY`, and `enableInstallTelemetry: false`.

## Documentation triggers

- README: user-visible capability, setup, configuration, limitation, or data flow.
- CHANGELOG: publish-worthy behavior.
- SECURITY: trust, credential, network, process, or sensitive-data changes.
- Root README: package add/remove/rename or material repositioning.

README openings state user problem/outcome, then only high-signal features. Keep edge cases and exhaustive reference material later. Root README is a concise, need-oriented package index.

## Validation matrix

| Change | Required checks |
| --- | --- |
| Docs only | `git diff --check` |
| Package code | package `check` and `test` |
| Bug fix | above plus regression test |
| Manifest/dependency | scoped lock refresh, `validate:packages`, `npm ci --dry-run` |
| Published files/assets | package `pack:dry-run`; inspect contents |
| Shared script/workflow/security | `npm run validate` |
| Private Pi API or TUI | tests plus package smoke test |

Use package scripts from repo root: `npm run -w packages/<slug> <script>`.

## Dependencies and lockfile

For package dependency changes:

```bash
npm install -w packages/<slug> --package-lock-only --no-audit --no-fund
npm ci --dry-run
```

Shared Pi API, telemetry, TypeScript, or policy migrations must update every affected package in one focused change and run root validation.

## Package lifecycle

### Add

1. Create required files; copy canonical configs from `templates/package/`; set manifest identity and resources.
2. Add implementation, package-specific `AGENTS.md`, docs, tests, telemetry.
3. Add package to root README index and root lockfile.
4. Run `validate:packages`, package checks/tests, and inspect pack dry run.

### Remove or rename

Reverse add steps: root index, workspace/lockfile, release metadata, docs, and references. Never reuse published package names without explicit approval.

## Git and PRs

Use feature branches and focused imperative commits. Never commit directly to `main`; never push unless asked.

Before PR:

```bash
git fetch origin main
git rebase origin/main
git status --short
git diff --check
git diff --stat
```

When asked to ship: commit, push, open PR, then monitor checks. After rebase/amend use `git push --force-with-lease`. Diagnose CI only for current PR head; fix and push rather than rerunning stale jobs.

After merge: fetch, switch to `main`, pull `--ff-only`, verify clean state and landed change, then delete local branch. Delete remote branch when requested.

## Publishing

Root is private. Publish workspaces independently. Release tags use `<package-name>@<version>`, including scoped names. Prefer `/release-package <package> <version>` in Pi. Before release, validate package, inspect `npm pack --dry-run`, and confirm version/CHANGELOG/tag match.

## Security

Never commit keys, tokens, auth headers, provider secrets, local Pi settings, sessions, or machine config. Do not run destructive commands on user data without explicit approval. Run `npm run validate` for security-sensitive changes.

<!-- BEGIN COMPOUND PI TOOL MAP -->
## Compound Engineering tools

Full CE functionality needs `pi-subagents`; interactive workflows benefit from `pi-ask-user`.

```bash
pi install npm:pi-subagents
pi install npm:pi-ask-user
```
<!-- END COMPOUND PI TOOL MAP -->
