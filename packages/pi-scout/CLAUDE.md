# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with `pi-scout`.

## Commands

```bash
npm install          # install deps
npm run check        # type-check (tsc --noEmit)
npm run pack:dry-run # verify published package contents
```

Local Pi testing (no install required):

```bash
pi -e /path/to/pi-mono/packages/pi-scout --print "list your tools"
```

## Architecture

`pi-scout` is a source-distributed Pi package. Pi loads TypeScript directly; there is no `dist/`.

- `index.ts`: package-level Pi extension entry point for clean startup display names.
- `extensions/index.ts`: extension wiring.
- `src/index.ts`: public package surface.

The package is currently scaffolded and intentionally behavior-light until its product scope is defined.

## Coding conventions

- ESM TypeScript, 2-space indentation, explicit `.js` import specifiers for local TypeScript modules.
- New reusable logic belongs in `src/`; Pi wiring belongs in `extensions/index.ts`; root `index.ts` should stay a thin re-export.
- When adding tools or commands, update README usage docs and add validation/tests where appropriate.
