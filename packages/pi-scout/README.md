# pi-scout

Give [Pi](https://pi.dev) proven codebases to learn from before it changes yours.

`pi-scout` clones and registers reference repositories, then exposes their local paths to the agent for fast, tool-native exploration across sessions.

> [!WARNING]
> Pi packages can execute arbitrary code through extensions. Review package source before installing any third-party Pi package.

## Features

- **Reference-driven coding** — let Pi inspect real implementations, conventions, and patterns instead of guessing.
- **One-step registration** — add Git URLs, local paths, or GitHub `owner/repo` shorthand from `/scout` or natural-language requests.
- **Fast local exploration** — shallow-clone references into a reusable private cache compatible with Pi's normal file tools.
- **Cross-session memory** — keep registered references available while their cached clones exist.
- **Clean context** — tell the agent only which references exist and where to inspect them; stale clones are pruned automatically.

Registered repositories are cloned in a private, per-user directory under the OS temp directory (`<temp>/pi-scout-<uid>` on Unix-like systems). Root and clone permissions are restricted to the current user on Unix. Set `PI_SCOUT_TMPDIR` to override the parent temp directory. Pi Scout uses shallow clones with depth `1` by default because it is for code exploration, not history exploration. Pi Scout keeps records in Pi's agent directory and reuses them across sessions while the cloned directories still exist.

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

## Configuration

| Variable | Purpose |
|---|---|
| `PI_SCOUT_TMPDIR` | Overrides the parent directory for temporary clones. |
| `PI_OFFLINE=1` | Disables install/update telemetry. |
| `PI_TELEMETRY=0` | Disables install/update telemetry. |

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
| `scout_add` | Clone and register a Git repository as a local reference codebase. Takes only `source`: Git URL, local path, or GitHub `owner/repo` shorthand. |
| `scout_rm` | Remove a repository from Pi Scout records, optionally deleting the temporary clone. Available to the model only while repos are registered. |

## Notes

- On startup, Pi Scout sends a best-effort install/update telemetry ping once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI.
- Pi Scout uses local file access for exploration. It does not provide web search or remote content-fetching tools.
- Registering a Git URL still uses `git clone`, so Git may contact the configured remote.
- Registered repositories are intended as read-only references unless the user explicitly asks otherwise.
- Repository state changes are serialized and persisted with atomic file replacement.
- The system prompt includes only registered repo names and local paths, not origin URLs or branch metadata.

## Development

```bash
npm install
npm run check
npm test
npm run pack:dry-run
```
