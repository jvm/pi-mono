# pi-processes

Keep long-running commands out of Pi's critical path without losing control of them.

`pi-processes` adds Codex-inspired process sessions to Pi on macOS and Linux. Start a build or server, continue other work, then poll its output or stop its process group. Use a PTY when a command needs a terminal.

- **Fast pipe path:** ordinary commands use Node's native pipes; the native PTY module loads only when requested.
- **Interactive when needed:** every non-empty PTY input write requires your approval, including control characters.
- **Bounded execution:** eight concurrent processes, bounded output and retained sessions, configurable timeouts, and group cleanup.
- **Provider-neutral:** public Pi tools and structured results work with direct calls and codemode.

This is a process runtime, **not a sandbox or subagent engine**. It neither installs provider overrides nor changes Pi's existing `bash` tool.

The tool names and lifecycle are inspired by [OpenAI Codex](https://github.com/openai/codex). The runtime is independently implemented; Codex's sandbox and approval machinery are not ported.

## Install

Install the first release:

```bash
pi install npm:pi-processes@0.1.0
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
| `max_output_tokens` | `4000` | Approximate output budget: four UTF-8 bytes per requested token, capped at 64,000 bytes |
| `timeout_ms` | `1800000` | Process lifetime limit, 100 ms to 24 hours |
| `notify_on_exit` | `false` | Request one follow-up turn when a background process completes |

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

Background completion queues one metadata-only message. By default it is delivered on the next turn without starting a model call. With `notify_on_exit:true`, it requests one follow-up turn, which can incur model usage. Foreground completion produces no additional message. No command text or process output is included in completion notifications.

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

No custom TUI or private Pi API patch is used.
