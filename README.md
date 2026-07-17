# pi-mono

Packages that make [Pi](https://pi.dev) better at sustained engineering work: stronger workflows, richer research, safer execution, and less friction.

Each package installs independently. Pick the capability you need, then follow its linked README for setup and usage.

## Find a package

### Build and manage work

| Need | Package | What it adds |
| --- | --- | --- |
| Keep Pi working toward a durable objective | [pi-goal](./packages/pi-goal) | Long-running, branch-aware goals with automatic continuation, budgets, and progress tracking. |
| Use a complete engineering workflow | [pi-compound-engineering](./packages/pi-compound-engineering) | Compound Engineering skills for brainstorming, planning, execution, review, and learning. |
| Help agents understand a repository | [pi-agentsmd](./packages/pi-agentsmd) | One-command generation of project-aware `AGENTS.md` guidance. |
| Control how skills are invoked and discovered | [pi-skillful](./packages/pi-skillful) | Inline invocation, prompt visibility controls, and session skill toggles. |
| Learn from reference implementations | [pi-scout](./packages/pi-scout) | Reusable local reference repositories for agent exploration. |

### Research and create

| Need | Package | What it adds |
| --- | --- | --- |
| Search the web, docs, and real code | [pi-web-kit](./packages/pi-web-kit) | Context-efficient web search, page fetch, library docs, and code search tools. |
| Generate or edit images | [pi-codex-image-gen](./packages/pi-codex-image-gen) | Conversational image generation and editing through `gpt-image-2` and ChatGPT Codex auth. |

### Safety and continuity

| Need | Package | What it adds |
| --- | --- | --- |
| Stop destructive shell commands | [pi-dcg](./packages/pi-dcg) | Destructive Command Guard checks before agent or user shell commands execute. |
| Keep a Mac awake while Pi works | [pi-insomnia](./packages/pi-insomnia) | Automatic macOS idle-sleep prevention for active agent runs. |

## Development

This repo uses npm workspaces. Run commands from the repository root unless package-specific docs say otherwise.

```bash
npm install
npm run check
npm test
npm run pack:dry-run
npm run validate
```

Package-specific validation and Pi smoke-test instructions live in each package's README and AGENTS.md.

## Tests

Run the monorepo test suite from the repository root:

```bash
npm test
```

## Security

Security policy and vulnerability reporting instructions are in [SECURITY.md](./SECURITY.md). GitHub security automation includes TruffleHog, Semgrep, CodeQL, zizmor, OpenSSF Scorecard, pinned action SHAs, Dependabot, and production dependency auditing.

For the full local validation loop, run:

```bash
npm run validate
```

Never commit API keys, tokens, auth headers, local Pi settings, provider configuration containing secrets, or machine-specific paths.

## Publishing

Each package is published independently to npm from its workspace package root.

```bash
npm publish --workspace packages/pi-web-kit
```

Before publishing a package, run its package-level validation and verify the package contents:

```bash
npm run pack:dry-run --workspace packages/pi-web-kit
```

The monorepo root is private and is not intended to be published.

GitHub release publishing uses package-specific tags in the form `<package>@<version>`:

```bash
git tag pi-web-kit@0.2.2
git push origin main pi-web-kit@0.2.2
gh release create pi-web-kit@0.2.2 --title "pi-web-kit@0.2.2" --notes "..."
```

Scoped package tags are also supported, for example `@mocito/pi-goal@0.1.10`.

The publish workflow dynamically resolves `packages/<package-slug>/package.json`, validates that the tag version matches the selected package's `package.json` version, then runs `npm publish --workspace packages/<package-slug> --provenance --access public`.

When working in Pi, the project-local `/release-package` command discovers publishable workspaces from `packages/*/package.json`, performs the validation, prints the exact commands it will run, asks for confirmation, then tags, pushes, and creates the GitHub release without invoking the agent:

```text
/release-package pi-web-kit 0.2.2
/release-package @mocito/pi-goal 0.1.10
```

## License

Unless otherwise noted, this repository is licensed under the MIT License. See [LICENSE](./LICENSE).

Individual packages may declare different licenses in their own `package.json` and `LICENSE` files. In particular, [pi-codex-image-gen](./packages/pi-codex-image-gen) is distributed under Apache-2.0 because it contains Apache-2.0-licensed material derived from OpenAI Codex.
