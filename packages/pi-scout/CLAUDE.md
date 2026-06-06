# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with `pi-scout`.

## Commands

```bash
npm run check        # type-check (tsc --noEmit)
npm run pack:dry-run # verify published package contents
```

Local Pi testing (no install required):

```bash
pi -e /path/to/pi-mono/packages/pi-scout --print "list your tools"
```

## Architecture

`pi-scout` is a source-distributed Pi package (no build step, Pi loads TypeScript directly).

### Data flow

`/scout` command or `scout_add` tool → `src/repo.ts` (shallow clone into `/tmp/pi-scout/`) → `src/state.ts` (persists to `<agentDir>/scout/repos.json`) → `before_agent_start` hook reads state and injects a system prompt snippet via `src/prompt.ts` listing registered repo paths.

### Key modules

| Module | Role |
|---|---|
| `extensions/index.ts` | Registers `scout_add`/`scout_rm` tools and `/scout` command; `scout_rm` is registered lazily and toggled active only when repos exist; injects scout context via `before_agent_start`. |
| `src/repo.ts` | Clones repos via `git clone --depth 1` into `/tmp/pi-scout/` (or `PI_SCOUT_TMPDIR`); resolves GitHub `owner/repo` shorthand to HTTPS URLs. |
| `src/state.ts` | Reads/writes `<agentDir>/scout/repos.json`; `loadPrunedState()` auto-removes records whose clone paths no longer exist on disk. |
| `src/prompt.ts` | Builds the `before_agent_start` system prompt snippet: a plain list of `name: path` entries prefixed with "Scout repos:". |
