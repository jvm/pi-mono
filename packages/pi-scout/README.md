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
Use Pi 1.1.0 or newer and Node.js >=22.19.0 for the structured tool contracts.

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

### Prompt updates

Pi Scout uses the structured prompt API in Pi 1.1.0 or newer. It owns the `scout_repos` section and updates that section without replacing the full system prompt or other extensions' sections. When the last reference is removed or its directory disappears, the section is removed on the next prompt.

The section contains only repository names, local paths, and read-only usage guidance. Origin URLs, credentials, branch names, and other record metadata are not included.

A deliberate full-prompt override from another extension (`systemPrompt` or `forceSystemPrompt`) takes precedence. Scout does not append to or rewrite that override, so its author controls whether reference context is included. Scout tools remain available according to their normal registration rules.

Pi records section updates in the session transcript. Providers that do not support mid-conversation system changes may require a full prompt checkpoint; this does not guarantee cache savings.

## Tools

| Tool | Purpose |
|---|---|
| `scout_add` | Clone and register a Git repository as a local reference codebase. Takes only `source`: Git URL, local path, or GitHub `owner/repo` shorthand. |
| `scout_rm` | Remove a repository from Pi Scout records, optionally deleting the temporary clone. Available to the model only while repos are registered. |

### Script results and discovery

Both tools declare output schemas and return objects, not strings, in codemode:

- `scout_add`: `{ repo }`.
- `scout_rm`: `{ removed: repo | null, deletedClone: boolean }`.
- `repo`: `{ id, name, path, branch?, createdAt, lastSeenAt }`. Origin/source
  metadata is deliberately excluded from text, structured results, and renderer
  details. Pi still records caller arguments; use Git's credential mechanisms,
  not credentials embedded in `source`.

After an explicit registration request:

```js
const { repo } = await tools.scout_add({ source: "owner/repo" });
text({ id: repo.id, path: repo.path });
```

The namespace is `scout`; tool names are unchanged. Await
`describeNamespace("scout")`, `describeTool("scout_add")`, or
`searchTools("reference repository", { namespace: "scout" })` for discovery,
including with zero inline budget. When adding the first reference, start a
**new codemode call** before discovering/calling `scout_rm`: Pi snapshots the
callable tools at script start.

Clone/process/storage failures throw and reject scripted calls. A missing
removal target is successful `{ removed: null, deletedClone: false }` data.
`deletedClone: true` means deletion was requested and the removal completed;
filesystem errors throw, and state removal may already have happened. These tools
do not return a structured success object with `isError: true`.
Human-readable direct results and the `/scout` menu remain available without
codemode.

Both tools run sequentially within Pi's dispatch queue. Await dependent calls;
this is not a cross-process transaction. Addition is a non-idempotent local
mutation that may contact a Git host. Removal is destructive, non-idempotent
(repeated names can match different records), and local-only. These advisory
hints do not authorize cloning or deletion; existing approval hooks still run.

No optional deferred/codemode exposure setting is added. Direct activation,
CLI exclusions, and conditional removal availability remain in force. Explicit
`defaultTools: ["-scout_rm"]` suppresses automatic removal-tool activation.
Manually disabling it is retained across prompts and reload, while repos remain.
If the repo set becomes empty and later gains a reference, the normal availability
transition can activate it again. Use a CLI exclusion for a lasting prohibition.

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
