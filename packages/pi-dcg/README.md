# pi-dcg

Stop destructive shell commands before they damage your system.

`pi-dcg` brings [Destructive Command Guard (dcg)](https://github.com/Dicklesworthstone/destructive_command_guard) policy checks into Pi, screening both agent-generated shell calls and your own `!` commands before execution.

## Features

- **Pre-execution protection** — block dangerous commands before Pi runs them.
- **Guard agent and user commands** — cover `bash` and `exec_command` startup calls plus `!command` and `!!command` invocations.
- **Actionable decisions** — surface matched rules and remediation while keeping hard denials non-overridable by the agent.
- **Your policy stays yours** — honor dcg's Pi-specific profiles, packs, allowlists, exceptions, and audit history.
- **Configurable failure posture** — choose fail-open convenience or fail-closed protection when dcg is unavailable.

`pi-dcg` is a Pi extension bridge. It does not bundle dcg, replace dcg policy, or provide a sandbox.

The TUI footer uses palette-neutral shield icons, with the configured
`blocking`/`fail-open` policy kept in text when unavailable. It does not retain
colors from an old theme. RPC confirmations and notifications remain separate
from this terminal-only status.

### Footer icons

| Display | State | Nerd Font glyph |
| --- | --- | --- |
| 󰕥 | DCG is available | `nf-md-shield_check` (`U+F0565`) |
| 󰶚 | Startup health probe is pending | `nf-md-shield_search` (`U+F0D9A`) |
| 󰦞 fail-open | DCG is unavailable; bridge failures allow commands | `nf-md-shield_off` (`U+F099E`) |
| 󰦞 blocking | DCG is unavailable; bridge failures block commands | `nf-md-shield_off` (`U+F099E`) |

Icons are the only display for healthy/checking states; the version remains
available through `/dcg`. Degraded states always retain the failure policy in
text, rather than relying on shape or color alone. Health is not a guarantee
that a specific command is safe or that dcg provides a sandbox.

Configure the terminal to use **Nerd Font 3 or later**, preferably its **Mono**
variant. There is no text fallback for icons and Pi cannot detect missing glyphs;
an unsupported font may display boxes. Guard decisions do not depend on the
terminal font.

## Requirements

- Node.js 22.19.0 or newer
- Pi, supplied by the host; contract-tested against Pi 1.1.0
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

By default, the extension checks both Pi shell events available to extensions:

- agent calls to Pi's built-in `bash` tool, including nested calls through codemode (`on` and `only`) or `ctx.executeTool()`;
- `exec_command` startup calls, including the monorepo's `pi-processes`, checked in their resolved `workdir`;
- user `!command` and `!!command` invocations.

Pi's separate RPC control-channel `{"type":"bash"}` command does not emit either event in current Pi releases and cannot be intercepted by `pi-dcg`; see [Limitations](#limitations).

For every non-empty command, the extension starts dcg directly without a shell, sends a Claude-compatible `PreToolUse` payload on stdin, and waits for dcg's decision before Pi executes the command.

Pi allows `tool_call` handlers to rewrite tool arguments in sequence. `pi-dcg` checks **in-place** mutations made by earlier handlers, then seals both the approved `command` value and its input reference. If a later handler attempts to replace either one, Pi blocks the tool call. Pi 1.1.0 has a separate argument-identity limitation when an earlier handler replaces the entire input object; see [Limitations](#limitations).

DCG does not replace the bash executor, activate excluded tools, or bypass another extension's approval hooks.

For `exec_command`, DCG canonicalizes `workdir`, checks `cmd` there, and seals all startup arguments against later changes. Interactive `write_stdin` is not DCG-validated: partial input can combine into commands that cannot be safely checked in isolation. `pi-processes` instead requires explicit human approval for every non-empty write. The earlier-input-object replacement limitation below also applies to `exec_command`.

| dcg response | Pi behavior |
| --- | --- |
| Empty stdout / explicit `allow` | Execute the command |
| `permissionDecision: "deny"` | Block and show bounded rule/remediation details |
| `permissionDecision: "ask"` | Ask for confirmation when UI is available; otherwise block |
| Bridge failure | Allow by default, warning when UI is available; configurable to block |

Hard denials are never converted into one-click approvals. When dcg provides an allow-once code, `pi-dcg` shows the exact `dcg allow-once ...` command only in a user-facing UI notification. It is deliberately excluded from the model-visible blocked tool result so an agent cannot redeem the exception itself.

DCG confirmation dialogs run one at a time per extension instance, so parallel bash calls cannot replace each other's DCG prompt. Policy checks and allowed commands remain concurrent. Turn cancellation dismisses the active confirmation and blocks queued confirmations; runtime shutdown, including reload or session replacement, also cancels pending checks and confirmations. Cancellation blocks even with `PI_DCG_ON_ERROR=allow`, and a late dialog response cannot approve a cancelled call.

RPC extension UI can confirm `ask` decisions. Print/JSON sessions without UI block them. RPC **agent tool calls** are distinct from the excluded RPC control-channel `bash` command.

Terminal confirmation dialogs use a bold accent title and normal-weight command/policy details in the theme's text color. The selected Yes/No option keeps Pi's accent highlight; unselected options use its normal text color. RPC prompts remain plain text.

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
- dcg runs with Pi's current working directory for `bash`, or the resolved command `workdir` for `exec_command`, preserving project policy and allow-once scope.
- Captured stdout and stderr share a 512 KiB limit.
- dcg's human stderr output is captured rather than copied into Pi logs or model context.
- Denial text sent back to Pi is bounded to prevent context flooding.

On startup, this package also sends the monorepo-standard best-effort install/update telemetry ping to `mocito.dev`, once per package version. It is disabled in CI and respects Pi offline and telemetry settings. It contains the package name/version and platform/runtime/architecture only—never commands, paths, dcg output, or policy.

## Limitations

This extension intercepts Pi events, not operating-system process execution. It cannot see:

- custom tools that execute commands under names other than `bash` or `exec_command`;
- interactive stdin sent to an already-running command;
- Pi's RPC control-channel `{"type":"bash"}` command, which does not emit a `user_bash` event;
- `pi.exec()` or child processes started internally by another extension;
- destructive behavior performed directly through non-shell tools;
- the contents of an opaque script invoked only as `./script.sh` unless dcg can infer or inspect the payload;
- commands that dcg itself intentionally allows after a parse, size, or deadline fallback.

`user_bash` handlers are first-result-wins in Pi. An earlier extension that fully handles `!` commands can prevent later handlers, including `pi-dcg`, from seeing them.

Two Pi 1.1.0 composition limits remain:

- If an earlier `tool_call` handler assigns a new object to `event.input`, Pi can execute the original arguments while DCG checks the replacement. Integrations must mutate argument fields in place, not replace the input object. DCG cannot repair this host contract after the replacement has occurred.
- The confirmation queue covers this DCG instance, not other extensions' dialogs. Concurrent dialogs from another extension can still displace a prompt in Pi's shared editor slot. Cross-extension dialog scheduling requires host-level coordination.

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
