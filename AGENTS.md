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

- Keep package names purpose-specific; do not create generic buckets such as `pi-prompt-templates`.
- Use conventional Pi resource directories inside a package: `extensions/`, `skills/`, `prompts/`, and `themes/`.
- Every package with extensions must include a root-level `index.ts` that re-exports the extension entry point, and configure the `pi` manifest to reference `./index.ts` (not `./extensions/index.ts`). This ensures Pi displays the extension as the package name (e.g., "pi-agentsmd") rather than the internal path.
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
- Every publishable package must include the `pi-package` keyword and a correct `pi` manifest in `package.json`.
- Keep npm publishing metadata package-local:
  - `repository.url`: `git+https://github.com/jvm/pi-mono.git`
  - `repository.directory`: `packages/<package-name>`
  - `bugs.url`: `https://github.com/jvm/pi-mono/issues`
  - `homepage`: `https://github.com/jvm/pi-mono/tree/main/packages/<package-name>#readme`
- Keep `files` arrays explicit so `npm pack` includes only intended runtime/docs assets.
- Pi core packages imported by extensions should stay in `peerDependencies` with a `"*"` range and in `devDependencies` for local type-checking.

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
