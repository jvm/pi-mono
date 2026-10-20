# pi-scout Guidelines

Root `AGENTS.md` applies.

## Invariants

- Treat registered repositories as read-only references unless user requests mutation.
- Keep clone storage private per user; preserve shallow clone default and atomic state writes.
- Prompt context exposes names and local paths, not origin metadata.
- Prune stale clone records before injecting context.
- Removal of non-temporary user data requires explicit approval.

## Validation

```bash
npm run -w packages/pi-scout check
npm test -w packages/pi-scout
npm run -w packages/pi-scout pack:dry-run
```

Smoke test: `pi -e packages/pi-scout --print "list your tools"`.

## Architecture

Data flow: `/scout` command or `scout_add` tool → `src/repo.ts` (shallow clone into `/tmp/pi-scout/`) → `src/state.ts` (persists to `<agentDir>/scout/repos.json`) → `before_agent_start` hook reads state and injects a system prompt snippet via `src/prompt.ts` listing registered repo paths.

| Module | Role |
|---|---|
| `extensions/index.ts` | Registers `scout_add`/`scout_rm` tools and `/scout` command; `scout_rm` is registered lazily and toggled active only when repos exist; injects scout context via `before_agent_start`. |
| `src/repo.ts` | Clones repos via `git clone --depth 1` into `/tmp/pi-scout/` (or `PI_SCOUT_TMPDIR`); resolves GitHub `owner/repo` shorthand to HTTPS URLs. |
| `src/state.ts` | Reads/writes `<agentDir>/scout/repos.json`; `loadPrunedState()` auto-removes records whose clone paths no longer exist on disk. |
| `src/prompt.ts` | Builds the `before_agent_start` system prompt snippet: a plain list of `name: path` entries prefixed with "Scout repos:". |
