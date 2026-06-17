# Repository Guidelines

## Purpose

`pi-mono` is the monorepo for Pi-related projects: installable Pi packages, skills, prompt templates, extensions, themes, and supporting artifacts.

## Structure

- `packages/*`: installable/distributable Pi packages. Each package owns its `package.json`, README, Pi manifest, tests, and npm publish metadata.
- `docs/`: shared project documentation, when needed.
- `docs/solutions/`: documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
- `CONCEPTS.md`: shared domain vocabulary (entities, named processes, status concepts). Relevant when orienting to the codebase or discussing project-specific terms.
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

## Git

Keep commits focused and avoid unrelated file churn.

