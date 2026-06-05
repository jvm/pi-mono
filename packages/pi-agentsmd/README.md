# pi-agentsmd

Generate `AGENTS.md` contributor guides for [Pi](https://pi.dev) repositories.

`pi-agentsmd` provides a `/init` command that analyzes the current repository and generates a concise, well-structured `AGENTS.md` file with repository-specific guidelines for contributors and AI agents.

## Features

- `/init` command to generate an `AGENTS.md` file at the repository root.
- Refuses to overwrite existing files unless `--force` is passed.
- Delegates generation to the AI model, which analyzes the repository structure, tooling, and conventions to produce tailored guidelines.
- Prompt adapted from [OpenAI Codex](https://github.com/openai/codex) (Apache 2.0).

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
