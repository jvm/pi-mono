# pi-scout

A source-distributed [Pi](https://pi.dev) package for registering local reference codebases for agent exploration.

> [!WARNING]
> Pi packages can execute arbitrary code through extensions. Review package source before installing any third-party Pi package.

## Features

- `/scout` slash command with a simple TUI flow for registering, listing, and removing reference repositories.
- `scout_register_repo` tool for cloning a Git repository into a local temporary cache.
- `scout_list_repos` and `scout_remove_repo` tools for agent-driven management.
- Per-turn system prompt guidance that tells the agent which registered codebases are available and where their local clone paths are.
- Automatic pruning: if the OS cleans a temporary clone, Pi Scout removes that stale entry before adding prompt context.

Registered repositories are cloned under the OS temp directory, currently `<tmp>/pi-scout/<name>-<id>`. Pi Scout keeps records in Pi's agent directory and reuses them across sessions while the cloned directories still exist.

## Installation

Install from npm:

```bash
pi install npm:pi-scout
```

Install project-locally with Pi's `-l` flag:

```bash
pi install -l npm:pi-scout
```

During local development from this monorepo:

```bash
pi install /path/to/pi-mono/packages/pi-scout
```

For a one-off test run without installing:

```bash
pi -e /path/to/pi-mono/packages/pi-scout --print "list your tools"
```

This is an npm-compatible TypeScript Pi package. There is no runtime build step.

## Quick usage

Open the Pi Scout menu:

```text
/scout
```

Register a repository directly with a Git URL/path or GitHub shorthand:

```text
/scout https://github.com/owner/repo.git
/scout owner/repo
```

Ask the agent to register one:

```text
Register https://github.com/owner/repo.git with Pi Scout, then inspect how it implements feature flags.
```

After a repository is registered, the agent sees its local path in the system prompt and can inspect it with local file tools.

## Tools

| Tool | Purpose |
|---|---|
| `scout_register_repo` | Clone and register a Git repository as a local reference codebase. Accepts Git URLs, local paths, and GitHub `owner/repo` shorthand. |
| `scout_list_repos` | List registered repositories and prune missing temp clones. |
| `scout_remove_repo` | Remove a repository from Pi Scout records, optionally deleting the temporary clone. |

## Notes

- Pi Scout uses local file access for exploration. It does not provide web search or remote content-fetching tools.
- Registering a Git URL still uses `git clone`, so Git may contact the configured remote.
- Registered repositories are intended as read-only references unless the user explicitly asks otherwise.
- The system prompt includes only registered repo names and local paths, not origin URLs or branch metadata.

## Development

```bash
npm install
npm run check
npm run pack:dry-run
```
