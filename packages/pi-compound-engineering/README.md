# pi-compound-engineering

> Compound Engineering for Pi: brainstorm, plan, work, review, and compound.

`pi-compound-engineering` brings [Every Inc.'s `compound-engineering-plugin`](https://github.com/EveryInc/compound-engineering-plugin) to [Pi](https://pi.dev). It mirrors the upstream plugin's `ce-*` skills so you can use the same compound engineering workflow in Pi that the CE team uses in Claude Code and Codex.

> [!WARNING]
> Pi packages can execute arbitrary code through extensions. Review package source before installing any third-party Pi package.

## Features

- **`ce-*` skills** — the full set of upstream CE skills: planning, code review, work execution, brainstorming, debugging, strategy, product pulse, and more.
- **Skills-only upstream alignment** — CE v3.14.0+ packages specialist prompts inside their owning skills. Pi follows that model and keeps the installed surface aligned with upstream.
- **`/ce-status`** — a slash command that reports the synced CE version, skill count, and detected peer packages.
- **One-shot dependency warnings** — gentle notifications on first session start when peer packages are missing.
- **Install-script warning** — fires when the `skills/` directory is empty and provides recovery steps for skipped or npm-blocked lifecycle scripts.
- **Skill resource paths** — bundled CE skill resources like `scripts/`, `references/`, and `assets/` are rewritten at conversion time to resolve under `skills/<skill-name>/...`, matching the package-root base path Pi injects for package-sourced skills. No runtime guidance is needed.

The exact skill list is visible in Pi's startup `[Skills]` list after install.

## Installation

Install from npm:

```bash
pi install npm:pi-compound-engineering
pi install npm:pi-subagents    # required for full functionality
pi install npm:pi-ask-user     # recommended for interactive skills
```

Install project-locally with Pi's `-l` flag:

```bash
pi install -l npm:pi-compound-engineering
pi install -l npm:pi-subagents
pi install -l npm:pi-ask-user
```

During local development from this monorepo:

```bash
pi install /path/to/pi-mono/packages/pi-compound-engineering
```

For a one-off test run without installing:

```bash
pi -e /path/to/pi-mono/packages/pi-compound-engineering
```

The install runs two lifecycle scripts:

1. `preinstall` (`scripts/stage.mjs`) downloads the pinned CE release tarball, verifies its SHA256, extracts it, runs the pure-Node converter, and stages the result in `~/.pi-compound-engineering-staging/`.
2. `postinstall` (`scripts/commit.mjs`) moves the staged content into the install directory.

Skills are available on the next Pi launch. The `tar` binary is required (universally available on macOS, Linux, and WSL; not native Windows). A working network connection is required at install time.

> [!IMPORTANT]
> npm 12 blocks dependency lifecycle scripts until the **Pi-managed npm install root** approves them. After reviewing this package's install scripts, approve `pi-compound-engineering` there and rebuild it. This package cannot approve itself because npm blocks its scripts before they run.

## Usage

The `ce-*` skills are available in any Pi session after install. The exact list is visible in the startup `[Skills]` list. Specialist prompts are loaded from their owning skill when a workflow needs them.

Run `/ce-status` to see the synced CE version, skill count, and peer-package detection.

If `pi-subagents` or `pi-ask-user` is missing, the extension emits a one-shot warning on first session start telling you how to install it. The package is fully usable without them; the skill bodies already contain fallback text (inline execution, numbered options in chat).

## Peer packages

This package uses two optional Pi extensions, which are not bundled. Install them separately:

- **`pi-subagents`** — provides the `subagent` tool. Required by skills that dispatch parallel agents. Without it, those skills fall back to inline execution.
- **`pi-ask-user`** — provides the `ask_user` tool. Used by interactive skills. Without it, those skills fall back to numbered options in chat.

Both are first-class Pi packages with their own release cadence. The package is fully usable without them.

## How it works

This package is a **recipe-only** loader. The `skills/` directory is not in the npm tarball; it is produced at install time from the upstream CE release. CE v3.14.0+ is intentionally skills-only.

```
pi-mono repo (this package)
  ├── src/                         # TypeScript: extension, telemetry, etc.
  ├── scripts/
  │   ├── stage.mjs                # preinstall: download + verify + stage root-native skills
  │   ├── commit.mjs               # postinstall: move staging to final install dir
  │   ├── converter.mjs            # pure-Node CE skill copier + Pi path adapter
  │   ├── verify.mjs               # structure check (counts + representative content)
  │   └── expected-sha256.txt      # SHA256 of the pinned CE release tarball
  ├── package.json                 # "preinstall" + "postinstall" lifecycle
  └── (no committed skills/ — generated at install time)

  User machine, at `pi install` time
  ├── ~/.pi/agent/npm/pi-compound-engineering/   # the install dir
  │   ├── src/, scripts/, package.json           # what was in the tarball
  │   ├── skills/                                # GENERATED by postinstall
  │   └── THIRD-PARTY-NOTICES                    # GENERATED by postinstall
```

The two-phase `preinstall` + `postinstall` design gives npm-native update safety: if `preinstall` fails (network, SHA, converter bug, structure check), npm aborts the install/update and the previous version remains untouched.

The converter (`scripts/converter.mjs`) is a pure-Node ESM port of the upstream CE-to-Pi converter. It has no npm dependencies — it runs with `node` alone, which is critical because the install-time scripts cannot rely on a working `node_modules/`.

At conversion time, the converter rewrites each skill's backtick-wrapped `references/`, `scripts/`, and `assets/` paths to `skills/<skill-name>/...` so they resolve against the package-root base path Pi injects for package-sourced skills. `npm run verify` asserts every rewritten ref resolves on disk. Upstream specialist prompts are copied with their owning skills under `references/`.

## Troubleshooting

### `skills/` is empty after install

`pi-compound-engineering` must run its `preinstall` and `postinstall` scripts to generate `skills/`. With npm 12, approve this reviewed package in Pi's npm install root, then rebuild it:

```bash
npm install-scripts approve pi-compound-engineering --prefix ~/.pi/agent/npm
npm rebuild pi-compound-engineering --prefix ~/.pi/agent/npm
```

For a project-local Pi package, replace `~/.pi/agent/npm` with `.pi/npm`. On npm versions before 12, ensure `ignore-scripts` is disabled and run the same `npm rebuild` command. Restart Pi after a successful rebuild.

Avoid approving all dependencies or enabling `dangerously-allow-all-scripts`; only this package needs approval.

### Behind a corporate proxy or offline

Set the `CE_TARBALL_PATH` environment variable to a local path of the upstream tarball (the pinned version is in `scripts/expected-sha256.txt`), then re-run the install:

```bash
CE_TARBALL_PATH=/path/to/compound-engineering-plugin.tar.gz pi install npm:pi-compound-engineering
```

### CI / air-gapped installs

The preinstall is a no-op when no `CE_TARBALL_PATH` is set **and** the environment looks like CI (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `TRAVIS`, `JENKINS_URL`, `BUILDKITE`, `APPVEYOR`, `DRONE`, `TEAMCITY_VERSION`, `NETLIFY`, `VERCEL`, `CODESPACES`, `BITBUCKET_BUILD_NUMBER`, `TF_BUILD`) or `PI_OFFLINE=1` is set. In that case the lifecycle completes successfully with an empty `skills/` dir, the install no longer aborts the whole workspace `npm ci`, and the skipped-postinstall warning fires on the next Pi launch with the recovery instruction. Force a network attempt by unsetting the relevant env var and reinstalling.

## Development

This package is source-distributed. Pi loads the TypeScript extensions directly.

Requirements:

- Node.js >= 20.6.0
- npm
- `tar` binary (macOS, Linux, WSL)

Windows is **not supported** out of the box. The preinstall shells out to `tar` to extract the upstream tarball, and Node 20's `tar` shim has different flag behavior on Windows. Use WSL or a Linux VM.

```bash
npm install
npm run check
npm run pack:dry-run
```

The structure check (`npm run verify`) downloads the pinned CE release and asserts the converter output is correct (counts + representative content). It runs in CI and on demand.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and pull request guidelines.

## Security

Please report security issues privately. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

The synced content from `compound-engineering-plugin` is also MIT. See [NOTICE](NOTICE) and the generated `THIRD-PARTY-NOTICES` in the install directory for the full attribution inventory.
