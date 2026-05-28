# pi-mono

Monorepo for Pi-related projects: installable Pi packages, skills, prompt templates, extensions, themes, and supporting artifacts.

## Packages

| Package | Description |
| --- | --- |
| [pi-codex-image-gen](./packages/pi-codex-image-gen) | Image generation for Pi using the ChatGPT Images 2.0 model. |
| [pi-goal](./packages/pi-goal) | Persistent long-running goals for Pi. |
| [pi-scout](./packages/pi-scout) | Register local reference codebases for Pi agent exploration. |
| [pi-skillful](./packages/pi-skillful) | Pi package with skill invocation and visibility improvements. |
| [pi-web-kit](./packages/pi-web-kit) | Context-efficient web search and fetch tools for Pi. |

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
git tag pi-web-kit@0.1.5
git push origin main pi-web-kit@0.1.5
gh release create pi-web-kit@0.1.5 --title "pi-web-kit@0.1.5" --notes "..."
```

Scoped package tags are also supported, for example `@mocito/pi-goal@0.1.0`.

The publish workflow dynamically resolves `packages/<package-slug>/package.json`, validates that the tag version matches the selected package's `package.json` version, then runs `npm publish --workspace packages/<package-slug> --provenance --access public`.

When working in Pi, the project-local `/release-package` command discovers publishable workspaces from `packages/*/package.json`, performs the validation, prints the exact commands it will run, asks for confirmation, then tags, pushes, and creates the GitHub release without invoking the agent:

```text
/release-package pi-web-kit 0.1.5
/release-package @mocito/pi-goal 0.1.0
```

## License

Unless otherwise noted, this repository is licensed under the MIT License. See [LICENSE](./LICENSE).

Individual packages may declare different licenses in their own `package.json` and `LICENSE` files. In particular, [pi-codex-image-gen](./packages/pi-codex-image-gen) is distributed under Apache-2.0 because it contains Apache-2.0-licensed material derived from OpenAI Codex.
