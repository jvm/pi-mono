# pi-agentsmd

Teach [Pi](https://pi.dev) and other coding agents how your repository works with one command.

`pi-agentsmd` analyzes your project and creates a tailored `AGENTS.md` with the commands, conventions, and contribution guidance agents need to make better changes from their first turn.

## Features

- **One-command repository onboarding** — run `/init` to generate guidance at the repository root.
- **Project-aware instructions** — the active model studies your structure, tooling, tests, and conventions instead of producing a generic template.
- **Safe regeneration** — existing guidance stays untouched unless you explicitly pass `--force`.
- **Proven foundation** — generation prompt is adapted from [OpenAI Codex](https://github.com/openai/codex) (Apache 2.0).

## Installation

Install from npm:

```bash
pi install npm:pi-agentsmd
```

Install project-locally:

```bash
pi install -l npm:pi-agentsmd
```

During local development from this monorepo:

```bash
pi install /path/to/pi-mono/packages/pi-agentsmd
```

## Usage

### Generate AGENTS.md

Run the `/init` command inside a repository:

```
/init
```

Pi will analyze the repository and create an `AGENTS.md` file with sections covering:

- Project structure & module organization
- Build, test, and development commands
- Coding style & naming conventions
- Testing guidelines
- Commit & pull request guidelines

### Overwrite existing AGENTS.md

If `AGENTS.md` already exists, use `--force` to regenerate it:

```
/init --force
```

## How it works

The `/init` command sends a structured prompt to the active AI model. The model uses its file-writing tools to analyze the repository and generate an `AGENTS.md` file tailored to the project. The package itself does not write the file — it delegates entirely to the model.

## Development

Requirements:

- Node.js >= 20.6.0
- npm

```bash
npm install
npm run check
npm run pack:dry-run
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and pull request guidelines.

## License

MIT. See [LICENSE](LICENSE).

Includes a prompt derived from [OpenAI Codex](https://github.com/openai/codex), licensed under the Apache License 2.0. See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
