# pi-dcg

Guard Pi shell commands with [Destructive Command Guard (dcg)](https://github.com/Dicklesworthstone/destructive_command_guard) before they execute.

`pi-dcg` is a Pi extension bridge. It does not bundle dcg, replace dcg policy, or provide a sandbox.

## Requirements

- Node.js 20.6 or newer
- Pi 0.80 or newer
- A separately installed `dcg` executable; dcg 0.6.8 or newer is recommended

Install dcg using its [upstream installation instructions](https://github.com/Dicklesworthstone/destructive_command_guard#installation), review its release-verification guidance, and confirm that the binary is visible in the same environment as Pi:

```bash
dcg --version
```

> **Separate license:** dcg is external software with its own nonstandard license, including an OpenAI/Anthropic rider. It is not included in this package. Review the [dcg license](https://github.com/Dicklesworthstone/destructive_command_guard/blob/main/LICENSE) before installing or using it.

## Install

```bash
pi install npm:pi-dcg
```

For project-local installation:

```bash
pi install -l npm:pi-dcg
```

For a one-off checkout test:

```bash
pi -e /path/to/pi-mono/packages/pi-dcg
```

## What it guards

By default, the extension checks both Pi shell entry points:

- agent calls to Pi's built-in `bash` tool;
- user `!command` and `!!command` invocations.

For every non-empty command, the extension starts dcg directly without a shell, sends a Claude-compatible `PreToolUse` payload on stdin, and waits for dcg's decision before Pi executes the command.

| dcg response | Pi behavior |
| --- | --- |
| Empty stdout / explicit `allow` | Execute the command |
| `permissionDecision: "deny"` | Block and show bounded rule/remediation details |
| `permissionDecision: "ask"` | Ask for confirmation when UI is available; otherwise block |
| Bridge failure | Allow by default, visibly marking dcg unavailable; configurable to block |

Hard denials are never converted into one-click approvals. When dcg provides an allow-once code, the blocked result shows the exact `dcg allow-once ...` command so the user can review and run it explicitly.

Run `/dcg` to probe the binary and show the active bridge configuration.

## Why this uses hook mode

The short upstream Pi recipe calls `dcg --robot test`. `pi-dcg` deliberately uses dcg's normal hook protocol instead because the current hook path provides the behavior expected from an agent integration:

- Pi-specific agent profiles and their pack/allowlist changes;
- hook policy and confidence handling;
- scoped allow-once checks and pending exception records;
- history/audit integration;
- structured rule, severity, explanation, and remediation fields.

The bridge sets `PI_CODING_AGENT=true` so dcg resolves `[agents.pi]` policy. It also sets `DCG_NO_SELF_HEAL=1` only for the child process: dcg's default hook self-healing targets Claude settings and should not rewrite those files merely because Pi asked for a decision.

## Configuration

`pi-dcg` uses environment variables for bridge behavior. dcg's own `DCG_*` variables and TOML files continue to control policy.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_DCG_BIN` | `DCG_BIN`, then `dcg` | Executable name or path. Leading `~/` is expanded. |
| `PI_DCG_TIMEOUT_MS` | `5000` | Whole child-process timeout, from 100 to 60000 ms. |
| `PI_DCG_ON_ERROR` | `allow` | `allow` (fail open) or `block` when the bridge cannot obtain a valid decision. |
| `PI_DCG_GUARD_USER_BASH` | `1` | Set to `0`, `false`, `no`, or `off` to skip user `!`/`!!` commands. |

Examples:

```bash
PI_DCG_BIN="$HOME/.local/bin/dcg" pi
PI_DCG_ON_ERROR=block pi
PI_DCG_GUARD_USER_BASH=0 pi
```

`PI_DCG_ON_ERROR=block` covers bridge failures such as a missing executable, timeout, malformed output, or oversized output. It cannot turn dcg's own intentional fail-open analysis decisions into failures. Configure dcg itself for stricter heredoc and hook behavior.

### Pi-specific dcg policy

Current dcg releases recognize the `pi` agent profile:

```toml
# ~/.config/dcg/config.toml or .dcg.toml
[agents.pi]
trust_level = "medium"
extra_packs = ["database", "containers"]
```

Use real pack or category IDs reported by `dcg packs`.

## Process and data handling

- The command is sent only to the local dcg child process over stdin.
- The extension never invokes a shell to start dcg.
- dcg runs with Pi's current working directory, preserving project policy and allow-once scope.
- Captured stdout and stderr share a 512 KiB limit.
- dcg's human stderr output is captured rather than copied into Pi logs or model context.
- Denial text sent back to Pi is bounded to prevent context flooding.

On startup, this package also sends the monorepo-standard best-effort install/update telemetry ping to `mocito.dev`, once per package version. It is disabled in CI and respects Pi offline and telemetry settings. It contains the package name/version and platform/runtime/architecture only—never commands, paths, dcg output, or policy.

## Limitations

This extension intercepts Pi events, not operating-system process execution. It cannot see:

- custom tools that execute commands under another tool name;
- `pi.exec()` or child processes started internally by another extension;
- destructive behavior performed directly through non-shell tools;
- the contents of an opaque script invoked only as `./script.sh` unless dcg can infer or inspect the payload;
- commands that dcg itself intentionally allows after a parse, size, or deadline fallback.

`user_bash` handlers are first-result-wins in Pi. An earlier extension that fully handles `!` commands can prevent later handlers, including `pi-dcg`, from seeing them.

Use a container, VM, sandbox, restricted credentials, backups, and review controls when a hard security boundary is required.

## Development

```bash
npm install
npm run -w packages/pi-dcg check
npm run -w packages/pi-dcg test
npm run -w packages/pi-dcg pack:dry-run
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).

## License

`pi-dcg` is MIT licensed. dcg is separate external software and is not covered by this package's MIT license. See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES).
