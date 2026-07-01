# Repository Guidelines

## Purpose

`pi-mono` is the monorepo for Pi-related projects: installable Pi packages, skills, prompt templates, extensions, themes, and supporting artifacts.

## Structure

- `packages/*`: installable/distributable Pi packages. Each package owns its `package.json`, README, Pi manifest, tests, and npm publish metadata.
- `docs/`: shared project documentation, when needed.
- `examples/`: examples or fixtures, when needed.
- `scripts/`: shared automation, when needed.
- `templates/`: starter templates for future Pi artifacts, when needed.

For now, this repo contains only packages under `packages/*`.

## Package conventions

All packages in this monorepo must follow these guidelines to ensure consistency. When creating a new package, use existing compliant packages (e.g., `pi-agentsmd`, `pi-scout`) as reference.

### Naming and identity

- Package names must use the unscoped `pi-*` format (e.g., `pi-agentsmd`, not `@mocito/pi-agentsmd`).
- Package names must be purpose-specific; do not create generic buckets such as `pi-prompt-templates`.
- The `author` field in `package.json` must use the full name: `"Jose Mocito"`.
- The `license` field should be `"MIT"` unless there is a specific reason for another license.
- The `"type": "module"` field is required in all packages (ESM).

### File structure

Every package must include these files at its root:

| File | Purpose |
|------|----------|
| `package.json` | Package manifest (see required fields below) |
| `tsconfig.json` | TypeScript configuration (canonical version below) |
| `.editorconfig` | Editor configuration (canonical version below) |
| `.gitignore` | Git ignore rules (canonical version below) |
| `AGENTS.md` | Agent instructions for this package |
| `README.md` | User-facing documentation |
| `CHANGELOG.md` | Release notes following Keep a Changelog |
| `CODE_OF_CONDUCT.md` | Contributor Covenant Code of Conduct |
| `CONTRIBUTING.md` | Contributor workflow and guidelines |
| `LICENSE` | License text |
| `SECURITY.md` | Security policy and vulnerability reporting |

`CLAUDE.md` files should only be created by Claude Code, not by other agents. Do not create `CLAUDE.md` files in package directories.

Use conventional Pi resource directories inside a package: `extensions/`, `skills/`, `prompts/`, and `themes/`. Include only directories the package actually uses.

### Extension entry point

Every package with extensions must include a root-level `index.ts` that re-exports the extension default export, and configure the `pi` manifest to reference `./index.ts` (not `./extensions/index.ts`). This ensures Pi displays the extension as the package name (e.g., "pi-agentsmd") rather than the internal path.

```ts
// index.ts (package root)
export { default } from "./extensions/index.js";
```

```json
// package.json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

### package.json required fields

Every publishable package must include:

```jsonc
{
  "name": "pi-<name>",                // unscoped pi-* format
  "version": "0.1.0",
  "description": "One-line description.",
  "type": "module",
  "license": "MIT",
  "author": "Jose Mocito",
  "exports": { ".": "./src/index.ts" },
  "pi": { "extensions": ["./index.ts"] },
  "keywords": ["pi-package", "pi-extension", "pi", /* ... */],
  "files": [ /* explicit list — see below */ ],
  "scripts": { /* see below */ },
  "peerDependencies": { /* Pi core packages with "*" */ },
  "devDependencies": { /* Pi core packages with pinned range */ },
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=20.6.0" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/jvm/pi-mono.git",
    "directory": "packages/<package-name>"
  },
  "bugs": { "url": "https://github.com/jvm/pi-mono/issues" },
  "homepage": "https://github.com/jvm/pi-mono/tree/main/packages/<package-name>#readme"
}
```

### `files` array

Keep `files` arrays explicit so `npm pack` includes only intended runtime/docs assets. Every package must include these in `files`:

```
index.ts, extensions, src, README.md, LICENSE, CHANGELOG.md,
SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md
```

Add package-specific entries as needed (e.g., `prompts/`, `skills/`, `THIRD-PARTY-NOTICES`, `NOTICE`, asset files). Do not include dev-only files (`AGENTS.md`, `CLAUDE.md`, `PLAN.md`, `TODO.md`, tests) or files created by other AI agents.

### Keywords

Every publishable package must include the `pi-package` keyword. Packages with extensions should also include `pi-extension` and `pi`. Add purpose-specific keywords after those.

### Dependencies

- Pi core packages imported by extensions must stay in `peerDependencies` with a `"*"` range and in `devDependencies` with a pinned range (e.g., `"^0.75.4"`) for local type-checking.
- Keep devDependency versions synchronized across all packages in the monorepo. When bumping `@types/node` or `typescript`, update all packages.

### Scripts

Every package must include these scripts:

```json
{
  "check": "tsc --noEmit",
  "typecheck": "tsc --noEmit",
  "pack:dry-run": "npm pack --dry-run"
}
```

Add `"test"` when the package has tests. Add `"format"` only if there is a distinct formatting step beyond type-checking.

### Install telemetry

Every publishable package must implement install telemetry using the separate module pattern:

- Create `src/install-telemetry.ts` following the pattern from `pi-goal`, `pi-scout`, or `pi-skillful`.
- Call `reportInstallTelemetry()` at the start of the extension entry point in `extensions/index.ts`.
- Telemetry is opt-out: disabled in CI, respects `PI_OFFLINE`, `PI_TELEMETRY` env vars, and `settings.json` → `enableInstallTelemetry: false`.
- Reports package name and version to `https://mocito.dev/api/report-install` with a 5-second timeout.
- Deduplicates by version using a state file in Pi's extensions directory.

### Canonical configurations

**tsconfig.json** — use this exact configuration:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["index.ts", "src/**/*.ts", "extensions/**/*.ts"]
}
```

Add `"tests/**/*.mjs"` to `include` if the package has tests. Do not add `esModuleInterop` or `allowImportingTsExtensions` unless strictly required.

**.editorconfig** — use this exact content:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false
```

**.gitignore** — use this content, adding package-specific entries as needed:

```gitignore
node_modules/
dist/
*.tgz
*.tsbuildinfo
.DS_Store
.env
.env.*
!.env.example
npm-debug.log*
```

## Development commands

Use npm for this monorepo and its current packages.

From the root:

```bash
npm install
npm run check
npm test
npm run pack:dry-run
npm run validate
```

From an individual package, follow that package's `AGENTS.md` and README. Package-specific instructions override root instructions for that package.

## Publishing

The root package is private and must not be published. Publish packages independently:

```bash
npm publish --workspace packages/<package-name>
```

Before publishing, run the package's validation commands and `npm run pack:dry-run --workspace packages/<package-name>`.

GitHub release publishing is monorepo-aware. Use release tags in the form `<package-name>@<version>`, for example `pi-web-kit@0.1.5`. The publish workflow validates that the tag version matches `packages/<package-name>/package.json`, then publishes that workspace with provenance.

When working in Pi, prefer the project-local `/release-package <package-name> <version>` command. It discovers publishable workspaces from `packages/*/package.json`, validates the release, prints the exact commands it will run, asks for confirmation, then tags, pushes, and creates the GitHub release without invoking the agent.

## Security

Do not commit generated build artifacts, `node_modules/`, local Pi settings, API keys, tokens, auth headers, provider configuration containing secrets, or machine-specific config. Keep changes scoped to the package or shared file relevant to the task.

Security hardening is enforced in GitHub Actions with TruffleHog secret scanning, Semgrep SAST, CodeQL, zizmor workflow auditing, OpenSSF Scorecard, pinned action SHAs, Dependabot, and `npm audit --omit=dev`. Before merging security-sensitive changes, run the full local validation when possible:

```bash
npm run validate
```

## Git and PR workflow

Use feature branches and PRs for all repo changes. Do not commit directly to `main`.

Before committing, check branch and status:

```bash
git status --short
git branch --show-current
```

If changes are on `main`, create a feature branch before staging:

```bash
git switch -c fix/<short-description>
```

Keep commits focused and avoid unrelated file churn.

When asked to "commit and push", "ship this", or "open a PR":

1. Commit the scoped changes.
2. Push the feature branch.
3. Open the PR with `gh pr create`.
4. Monitor PR checks until pass/fail is known.

Do not stop at a PR creation link unless the user explicitly asks not to open the PR.

Before pushing or opening a PR, sync with `main`:

```bash
git fetch origin main
git rebase origin/main
```

After an amend or rebase, push with:

```bash
git push --force-with-lease
```

### Dependency and lockfile changes

This repo uses the root workspace lockfile. Any change to a package version or workspace dependency in `packages/*/package.json` must update the root `package-lock.json`.

Prefer scoped lock refreshes:

```bash
npm install -w packages/<package-name> --package-lock-only --no-audit --no-fund
```

Before PR, verify at least:

```bash
npm run -w packages/<package-name> check
npm ci --dry-run
git diff --stat
```

### CI failures

When CI fails, inspect the failed job logs and confirm the failure belongs to the current PR head SHA before rerunning anything:

```bash
gh pr checks <pr-number>
gh pr view <pr-number> --json headRefOid
git rev-parse HEAD
gh run view <run-id> --log-failed
```

Prefer fixing, rebasing onto `origin/main`, and pushing the corrected branch over rerunning stale checks or adding no-op commits.

### After merge

After the user merges a PR:

```bash
git fetch origin main
git switch main
git pull --ff-only
git status --short
```

Delete the local feature branch after verifying the change landed on `main`. For squash merges, `git branch -d` may fail; `git branch -D <branch>` is allowed only after verifying the merged change is present on `main`.

<!-- BEGIN COMPOUND PI TOOL MAP -->
## Compound Engineering (Pi compatibility)

This block is added by the pi-compound-engineering package.

Pi extensions used by skills shipped by this package:
- Required for full functionality: `pi-subagents` (by nicobailon) provides the `subagent` tool used by ce-compound, ce-code-review, ce-plan, ce-compound-refresh, and other parallel-agent skills.
- Recommended: `pi-ask-user` (by edlsh) provides the `ask_user` tool; skills fall back to numbered options in chat when it is missing.

Install with:
  pi install npm:pi-subagents
  pi install npm:pi-ask-user
<!-- END COMPOUND PI TOOL MAP -->
