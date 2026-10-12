# pi-processes

Keep long-running commands out of Pi's critical path without losing control of them.

`pi-processes` adds Codex-inspired process sessions to Pi on macOS and Linux. Start a build or server, continue other work, then poll its output or stop its process group. Use a PTY when a command needs a terminal.

- **Fast pipe path:** ordinary commands use Node's native pipes; the native PTY module loads only when requested.
- **Interactive when needed:** every non-empty PTY input write requires your approval, including control characters.
- **Always visible:** a persistent TUI widget shows live background commands, session ID prefixes, pipe/PTY mode, and elapsed time.
- **Push results when needed:** opt-in completion delivery sends bounded output to the model, with steering or follow-up timing.
- **Bounded execution:** eight concurrent processes, bounded output and retained sessions, configurable timeouts, and group cleanup.
- **Provider-neutral:** public Pi tools and structured results work with direct calls and codemode.

This is a process runtime, **not a sandbox or subagent engine**. It neither installs provider overrides nor changes Pi's existing `bash` tool.

The tool names and lifecycle are inspired by [OpenAI Codex](https://github.com/openai/codex). The runtime is independently implemented; Codex's sandbox and approval machinery are not ported.

## Install

Install the package:

```bash
pi install npm:pi-processes@0.2.0
```

For DCG startup protection, also install the companion guard release:

```bash
pi install npm:pi-dcg@0.4.0
```

`pi-dcg` requires a separately installed `dcg` executable. Its default bridge failure policy is fail-open; start Pi with `PI_DCG_ON_ERROR=block` to block startup when checks cannot run.

From a local monorepo checkout:

```bash
npm install
pi -e ./packages/pi-processes
```

Requirements: Node >=22.19.0, macOS or Linux, and a Pi host. Public API contracts are tested against Pi 1.1.0. `node-pty` 1.2.0-beta.15 is an optional native dependency: pipes work without it, but `tty:true` fails explicitly if its binding cannot load. This exact upstream prerelease fixes the macOS helper's missing execute permission in stable 1.1.0; no runtime permission repair is needed. A source build may need a C/C++ toolchain, Python, and Node headers. Review npm's lifecycle-script policy if native installation is disabled.

Do not load another extension that registers `exec_command` or `write_stdin` at the same time.

## Tools

### `exec_command`

```json
{"cmd":"npm test","yield_time_ms":1000,"notify_on_exit":true}
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `cmd` | required | Shell command, at most 65,536 characters |
| `workdir` | Pi cwd | Directory, resolved relative to Pi cwd |
| `tty` | `false` | Allocate a 120×40 PTY instead of pipes |
| `yield_time_ms` | `10000` | Initial wait, capped at 30 seconds; zero returns immediately |
| `max_output_tokens` | `4000` | Approximate output budget: four UTF-8 bytes per requested token, capped at 64,000 bytes; also bounds the completion tail when enabled |
| `timeout_ms` | `1800000` | Process lifetime limit, 100 ms to 24 hours |
| `notify_on_exit` | `false` | Request one follow-up turn when a background process completes |
| `completion_mode` | omitted | Opt in to output delivery using `nextTurn`, `followUp`, or `steer`; overrides `notify_on_exit` |

Linux uses `/bin/bash --noprofile --norc -c`; macOS uses `/bin/zsh -f -c`. Neither uses login-shell initialization. Commands inherit Pi's environment and filesystem/network permissions. Pipe stdin is closed. stdout/stderr are merged by arrival, not guaranteed to preserve ordering between streams.

### `write_stdin`

```json
{"session_id":"<returned id>","chars":"","yield_time_ms":1000}
```

Empty `chars` polls without input approval. Non-empty `chars` requires `tty:true` and a separate confirmation for that exact input. Input is capped at 4,096 characters. Control characters are shown escaped in the prompt. TUI and RPC confirmation are supported; print/JSON sessions block non-empty writes. Dialog failure, rejection, timeout, or cancellation blocks the write.

Empty polls default to one second and cap at five minutes. Input writes default to 250 ms and cap at 30 seconds. `max_output_tokens` uses the same approximate byte budget as startup.

Calls for the same process serialize, including input approval; different process sessions run concurrently. Each poll consumes the next output segment. Cancelling a poll leaves the process running; use `process_kill` to stop it. Cancelling the initial `exec_command` wait terminates that newly created process.

### `process_list` and `process_kill`

`process_list({})` lists retained IDs and status without consuming output. `process_kill({"session_id":"..."})` sends SIGTERM to the owned POSIX process group, escalates to SIGKILL after 500 ms, and returns remaining bounded output. You cannot supply an arbitrary PID.

### Results and retention

Every execution/poll result includes:

```json
{
  "session_id":"<opaque UUID>",
  "status":"running",
  "exit_code":null,
  "signal":null,
  "output":"...",
  "dropped_bytes":0,
  "unread_bytes":0,
  "timed_out":false
}
```

IDs are strings, not Codex's numeric IDs; this is an inspired API, not a drop-in Codex protocol. Terminal escape/control sequences are removed from returned output. Nonzero exits remain process data, not a failed polling operation.

Each process retains the latest 1 MiB of unread output in memory. Read promptly for verbose jobs. Overflow is reported in `dropped_bytes`; `unread_bytes` indicates further output to poll. **There is no complete disk log or restart recovery.** At most 32 records are retained; older completed records are evicted as new jobs start. All records and live processes belong to the current Pi extension runtime and are discarded on shutdown, reload, or session replacement.

Without `completion_mode`, background completion queues one metadata-only message. By default it is delivered on the next turn without starting a model call. With `notify_on_exit:true`, it requests one follow-up turn, which can incur model usage. This legacy path does not include command text or process output. Foreground completion produces no additional message in any mode.

### Push completion results to the model

To receive a background test result without polling:

```json
{"cmd":"npm test","yield_time_ms":1000,"completion_mode":"steer","max_output_tokens":4000}
```

| Mode | While Pi is working | While Pi is idle |
| --- | --- | --- |
| `nextTurn` | Wait for a new prompt; do not inject into the current run's tool continuations | Do not start a model turn |
| `followUp` | Deliver when the current agent run would otherwise stop | Start a model turn |
| `steer` | Deliver at the next safe model boundary, after the current turn and its tool batch complete | Start a model turn |

Steering does not modify an inference already in progress, cancel tools, or bypass input approval. `completion_mode` takes precedence over `notify_on_exit`, including `nextTurn` overriding a legacy wake request. `followUp` and `steer` can incur additional model usage.

The one-shot completion message includes the process ID, exit status, signal, timeout flag, and a sanitized **tail of all output received**, including output already returned by startup or polling. The tail uses the initial `max_output_tokens` byte budget (16,000 bytes by default; maximum 64,000 bytes). `output_scope:"completion_tail"` identifies it, and `dropped_bytes` counts raw output bytes omitted from this tail, independently of polling overflow. UTF-8 characters are kept whole.

Completion capture is separate from the unread polling buffer. It does not consume output or reset polling loss counters. You may see duplicate output if you poll as well. The duplicate buffer is released when the notification is built; no complete transcript or disk log is added.

Pushed output is explicitly labeled as untrusted command data, not instructions. The extension does not attach command or input arguments, but output can echo either and can contain secrets or prompt injection. Opt in only for output you intend to send to your model provider and store in Pi's normal session transcript. Shutdown and reload suppress completion delivery from processes they terminate.

### Background process widget

In interactive Pi, live background processes appear above the editor:

```text
Background processes · 2
  7036d2a5 · pipe · 12s · npm test
  b50d91ce · PTY · 4s · read -r answer
Poll: write_stdin · Stop: process_kill
```

Only processes whose initial call returned `running` appear. Foreground calls and completed records do not occupy the widget. Membership changes immediately on process exit, kill, or timeout, without polling or a model turn. Elapsed time refreshes once per second while jobs remain. The widget disappears when the last job exits and clears on reload, shutdown, or session replacement.

Each command preview is bounded to the first 256 UTF-16 code units, escapes terminal controls and direction-changing Unicode characters, and truncates to the available terminal width. It is a preview, not a full command or safety decision. Commands can contain secrets; do not place credentials in command arguments. No process output or submitted PTY input is displayed or consumed by the widget.

The widget is display-only. Ask Pi to use `process_list` for full session IDs, `write_stdin` with empty `chars` to poll, or `process_kill` to stop a process. Other extensions' widgets, editor, and footer remain unchanged. RPC, print, and JSON modes do not create this terminal widget.

## Command policy

Enable `pi-dcg` 0.4.0 or newer alongside this extension for DCG startup checks. It checks `exec_command.cmd` in the resolved `workdir` and seals startup arguments against later mutations. It also keeps its existing `bash` and user-shell coverage. Earlier `pi-dcg` releases do not check `exec_command`.

DCG is optional and inherits its configured fail-open/fail-closed policy. Set `PI_DCG_ON_ERROR=block` for bridge failures to block startup. Without a guard extension, startup follows Pi's normal local-tool behavior; this package does not add a startup confirmation.

**DCG cannot safely validate partial interactive input.** The per-write confirmation is a separate human decision, not a DCG allow decision. Approving input can execute destructive commands or alter a shell's state. Tool hooks remain applicable to direct and nested/codemode calls, but hooks written only for `bash` do not automatically cover these tools. The Pi 1.1.0 earlier-input-object replacement limitation described in pi-dcg also applies.

See [SECURITY.md](SECURITY.md) for process-group and isolation limitations.

## Development and smoke test

From the repository root:

```bash
npm run -w packages/pi-processes check
npm test -w packages/pi-processes
npm run -w packages/pi-processes pack:dry-run
```

The tests execute real pipe and PTY processes without model credentials, and exercise a real Pi session with a synthetic provider, codemode, and DCG decisions.

Manual smoke test on both platforms:

1. Load this package and `pi-dcg` in a disposable directory with `PI_DCG_ON_ERROR=block`.
2. Start `printf 'ready\n'; sleep 3; printf 'done\n'` with a short initial wait. Continue other work and poll the returned ID.
3. Start `read -r answer; printf '%s\n' "$answer"` with `tty:true`. Reject one input write, then approve `hello\n`. Verify only the approved write reaches the process.
4. Start `sleep 60 & wait`, stop its ID, and verify both shell and child exit.
5. Start another sleeper, then reload or switch sessions. Verify it exits and its old ID is unavailable.
6. Request `notify_on_exit:true` once. Verify one metadata-only completion follow-up. Repeat without it and verify no unsolicited model turn.
7. Repeat input rejection/approval with an RPC client that implements Pi's extension UI protocol.
8. In interactive Pi, start two sleepers with short initial waits. Verify both appear above the editor while Pi is idle and their elapsed times advance. Kill one and verify the count drops. Let the other finish without polling and verify the widget disappears. Repeat with a foreground command and verify no widget appears.
9. While a background process is visible, resize the terminal and switch between light, dark, and system themes. Verify lines fit, the editor remains usable, and other extensions' widgets remain present. Repeat in regular and fullscreen modes.
10. Start `sleep 3; printf 'test failed\n'; exit 7` with `yield_time_ms:0` and `completion_mode:"steer"`. Leave Pi idle. Verify the next model turn receives the exit code and output without polling. Poll afterward and verify the output remains available. Repeat while Pi is doing other work, then compare with `followUp` and `nextTurn`.

The widget uses public Pi UI APIs. No editor/footer replacement or private Pi API patch is used.
