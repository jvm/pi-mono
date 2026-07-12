# Repository Guidelines

`pi-compound-engineering` ships Every Inc.'s [compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) (CE) for Pi. The package is a **recipe-only** loader: it commits the glue code (extension, telemetry, dependency detection, `/ce-status` command) and a pure-Node port of the upstream CE-to-Pi converter. At `npm install` time, a `preinstall` script fetches the pinned CE release from GitHub, verifies its SHA256, and stages the resulting `skills/` in a temp dir. A `postinstall` script then commits the staged content into the package's install directory.

The package normally tracks the upstream `compound-engineering` component version (e.g. CE `3.13.0` → `pi-compound-engineering@3.13.0`). A Pi-specific hotfix may increment the package patch while retaining the upstream version in `package.json` → `ceVersion`, so users can identify the mirrored CE release.

## Project Structure & Module Organization

```
packages/pi-compound-engineering/
├── index.ts                       # Re-exports the extension default
├── extensions/
│   └── index.ts                   # Extension entry point
├── src/
│   ├── install-telemetry.ts       # Standard install telemetry
│   ├── ce-version.ts              # CE_VERSION constant and helpers
│   ├── dependency-check.ts        # Detects pi-subagents / pi-ask-user
│   ├── agents-block.ts            # Renders the AGENTS.md dependency block
│   ├── status-command.ts          # /ce-status slash command
│   └── index.ts                   # Public API surface
├── scripts/
│   ├── stage.mjs                  # preinstall: download + verify + stage root-native skills
│   ├── commit.mjs                 # postinstall: move staging to install dir
│   ├── converter.mjs              # pure-Node CE skill copier + Pi path adapter
│   ├── verify.mjs                 # structure check (counts + content)
│   └── expected-sha256.txt        # SHA256 of the pinned CE release tarball
├── package.json                   # has "preinstall" and "postinstall"
├── tsconfig.json
├── .editorconfig
├── .gitignore
├── NOTICE                         # Attribution to Every Inc.
├── README.md
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
└── SECURITY.md
```

There is **no committed `skills/` directory**. It is generated at install time by the `postinstall` script and lives in the install directory only. It is gitignored. CE v3.14.0+ is intentionally skills-only: specialist behavior is packaged as skill-local prompt assets, not registered standalone agents.

`PLAN.md` is gitignored as a transient planning artifact. It is **not** part of the package's working state and is deleted after the implementation is confirmed (see "Updating the upstream pin" in `CONTRIBUTING.md` for the workflow that consumes it).

## Build, Test, and Development Commands

```bash
# Install the package (also runs preinstall + postinstall, populates install dir)
npm install

# Typecheck
npm run check

# Structure check (counts + content) — runs the fetch in a temp dir
npm run verify

# Preview the npm package contents
npm run pack:dry-run

# Standalone run of each lifecycle phase
npm run stage       # node scripts/stage.mjs
npm run commit      # node scripts/commit.mjs
```

There is no runtime build step. The `preinstall` and `postinstall` scripts are pure-Node ESM and use only Node built-ins (`fs/promises`, `path`, `crypto`, `node:stream`, `child_process` for the system `tar` binary).

For local Pi testing, install the workspace package into a temporary project:

```bash
pi install -l /Users/jmocito/repos/pi-mono/packages/pi-compound-engineering
pi install npm:pi-subagents
pi install npm:pi-ask-user
pi
```

Then run `/ce-status` inside Pi and check the `[Skills]` list for the 29 `ce-*` entries.

## Coding Style & Naming Conventions

Follow `.editorconfig`: UTF-8, LF line endings, final newline, two-space indentation, and trimmed trailing whitespace except in Markdown. This is an ESM TypeScript package; keep imports explicit and prefer typed interfaces for the Pi API boundaries. Use `camelCase` for functions and variables, `PascalCase` for types/interfaces, and kebab-case for feature files (e.g. `dependency-check.ts`).

The `scripts/*.mjs` files are plain JavaScript with JSDoc annotations for IDE help — no transpile step. Keep the converter, the fetcher, and the verifier separate; do not introduce npm dependencies in the install-time scripts.

## The Recipe-Only Model

The package is the **glue**, not the artifact. The committed source is small TypeScript plus a pure-Node conversion adapter. The upstream skills are not in the npm tarball; they are produced at install time from the upstream CE release.

This is by design: see `README.md` for the rationale. The implementation rules:

1. **No in-tree modifications of CE content.** The only file in the package that contains CE-derived logic is `scripts/converter.mjs`, and it is a translation layer, not a content fork. Pi-specific workarounds belong upstream in CE (preferred). For portability gaps that can be solved at runtime (for example, helping Pi agents resolve bundled skill `scripts/` or `references/`), prefer extension-provided context over converter text rewrites. Use converter transforms only when runtime guidance cannot solve the issue and upstreaming is blocked.

2. **SHA256 pin is a supply-chain guard.** `scripts/expected-sha256.txt` is the contract that ensures every install pulls the same artifact. Update it only after reviewing the upstream release notes — never in bulk, never in CI.

3. **Pre/postinstall pair is non-negotiable.** The two-phase lifecycle is what gives us npm-native update safety. Do not collapse them into a single `postinstall` step. Do not introduce install-time work outside the `scripts/*.mjs` files.

4. **The `THIRD-PARTY-NOTICES` file is generated, not committed.** It is regenerated by the converter on every install and lists every converted file with its upstream path. It is shipped in the install directory only.

## Updating the Upstream Pin

When CE upstream tags a new release (e.g. `compound-engineering-v3.19.0`):

1. Bump `CE_VERSION` in `src/ce-version.ts`, `PACKAGE_VERSION` in the same file, and the `"version"` and `"ceVersion"` fields in `package.json` to the new upstream version string. For a Pi-only hotfix, increment only the package version and `PACKAGE_VERSION`; retain the existing `CE_VERSION` and `ceVersion`.
2. Compute the new SHA256 locally:
   ```bash
   curl -sL "https://codeload.github.com/EveryInc/compound-engineering-plugin/tar.gz/refs/tags/compound-engineering-v<NEW_VERSION>" | sha256sum
   ```
3. Replace the contents of `scripts/expected-sha256.txt` with the new SHA.
4. Run `npm run verify` locally to confirm the fetch + conversion works end-to-end. If the skill count has changed, update the expected count in `src/ce-version.ts`.
5. Add a `CHANGELOG.md` entry under a new `## [<version>] - <date>` heading, summarising the upstream changes.
6. Commit (small diff: `src/ce-version.ts`, `package.json`, `scripts/expected-sha256.txt`, `CHANGELOG.md`).
7. Open a PR to `main`. CI runs `verify` against the upstream tag.
8. Tag the merge commit as `pi-compound-engineering@<version>` and push the tag. The publish workflow handles the rest.

## Testing Guidelines

There is no dedicated test suite. The CI guard is `npm run verify`:

- It independently downloads and converts the pinned tarball into a temp dir, producing fresh `skills/` and `THIRD-PARTY-NOTICES`.
- It asserts the expected count (29 skills for v3.19.0).
- It asserts representative skills and new functionality (`ce-pov`, `ce-explain`, `ce-sweep`).
- It verifies every rewritten skill-local resource reference resolves on disk.
- It verifies `ce-plan` includes its architecture specialist as a skill-local prompt asset and that no standalone agents are emitted.

A failure in any of these checks means the recipe is broken (converter port regression, upstream restructure, or SHA pin pointing to a different artifact). The CI step surfaces the failure with the exact check that failed.

## Security & Configuration Tips

The `preinstall` and `postinstall` scripts run as the user and download code from GitHub. This is the same risk profile as any npm postinstall. The mitigations are baked in:

- The SHA256 pin in `scripts/expected-sha256.txt` prevents silent content swaps.
- The postinstall source is in the package repo (auditable).
- The converter is plain JavaScript with no `eval` and no `Function()` constructor.
- The README links to the source so a security-conscious user can read the recipe before installing.
- No code from the downloaded tarball is executed — we only read text files and write them to the install dir.

`pi-subagents` and `pi-ask-user` are **not** npm dependencies. They are peer Pi packages the user installs separately. The package is fully usable without them — `ce-plan` and friends fall back to numbered options in chat when `ask_user` is missing, and skills that need `subagent` will simply not have the tool available.

Global settings live at `~/.pi/agent/settings.json`; project settings live at `.pi/settings.json`. The `AGENTS.md` block written by `src/agents-block.ts` is appended to the project's `AGENTS.md` (i.e. `<cwd>/AGENTS.md`) and is gated by `<!-- BEGIN COMPOUND PI TOOL MAP -->` / `<!-- END COMPOUND PI TOOL MAP -->` markers; it is idempotent across reloads.

## Commit & Pull Request Guidelines

Use short imperative commit messages. Examples: `Add /ce-status command`, `Bump compound-engineering to 3.14.0`, `fix: pin converter to node:stream built-ins`. Keep commits scoped and concise.

Before opening a PR:

- Run `npm run check`.
- Run `npm run verify` and confirm counts + content match the expected pin.
- Run `npm run pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` for user-facing behavior changes.
- Update `CHANGELOG.md` for notable changes.

PR descriptions should summarize the change, mention the upstream CE version (if a release bump), link related issues when available, and include terminal output from `npm run verify` and `npm run pack:dry-run`.
