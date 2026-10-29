# pi-processes

Keep long-running commands out of Pi's critical path without losing control of them.

`pi-processes` extends Pi's `bash` tool with task-aware process execution on macOS and Linux. Keep ordinary shell calls unchanged, overlap a finite background job with independent work, or keep a service running. Background results arrive automatically; humans can inspect and stop processes without asking the model.

- **Fast pipe path:** ordinary commands use Node's native pipes; the native PTY module loads only when requested.
- **Interactive when needed:** every non-empty PTY input write requires your approval, including control characters.
- **Always visible:** a persistent TUI widget shows live background commands, session ID prefixes, pipe/PTY mode, and elapsed time.
- **No polling loops:** explicit background mode delivers bounded output at a safe model boundary and resumes the requesting task.
- **Local process manager:** one live `/processes` screen for output following, explicit failure acknowledgment, stopping, and completed-output cleanup.
- **Compact review:** four output lines by default, bounded expansion, and line/page/segment navigation with horizontal scrolling.
- **Bounded execution:** eight concurrent processes, bounded output and retained sessions, configurable timeouts, and group cleanup.
- **Provider-neutral:** public Pi tools and structured results work with direct calls and codemode.

### Codemode discovery

All six tools share the `processes` namespace. At inline budget zero, use
`await describeNamespace("processes")` for lifecycle instructions and
`await describeTool(name)` for schemas. Excluded tools stay unavailable.
Inspection and wait guidance remains available when `bash` is excluded.

```js
const r = await tools.bash({ command: "npm test", mode: "background" });
text({ id: r.session_id, status: r.status });
// Continue independent work. When the results become dependencies:
const done = await tools.process_wait({ session_ids: [r.session_id], acknowledge: true });
text(done.processes.map(p => ({
  id: p.session_id, status: p.status, exit: p.exit_code,
  signal: p.signal, timed_out: p.timed_out, diagnostic: p.output.slice(-1000),
})));
```

Check wait interruption/deadline fields before treating results as complete.
Acknowledgement is explicit for nested results; discarding script results does
not suppress background delivery. Never use a loop to poll for completion.

This is a process runtime, **not a sandbox or subagent engine**. It replaces the `bash` tool through Pi's public extension API, without provider overrides. Calls without `mode` delegate to Pi's built-in executor.

The tool names and lifecycle are inspired by [OpenAI Codex](https://github.com/openai/codex). The runtime is independently implemented; Codex's sandbox and approval machinery are not ported.

## Install

The unified `bash` interface is unreleased; use a local checkout of both `pi-processes` and `pi-dcg` to test it. It replaces `exec_command`, with no compatibility alias. Update scripts to use `bash`, rename `cmd` to `command`, convert `timeout_ms` to `timeout` in seconds, and choose an explicit mode instead of the removed `yield_time_ms`, `notify_on_exit`, and `completion_mode` startup options. Managed commands retain bounded output in private temporary storage; see [SECURITY.md](SECURITY.md).

Install the package:

```bash
pi install npm:pi-processes@0.3.0
```

For DCG startup protection, also install the companion guard release:

```bash
pi install npm:pi-dcg@0.4.1
```

`pi-dcg` requires a separately installed `dcg` executable. Its default bridge failure policy is fail-open; start Pi with `PI_DCG_ON_ERROR=block` to block startup when checks cannot run.

From a local monorepo checkout:

```bash
npm install
pi -e ./packages/pi-processes
```

Requirements: Node >=22.19.0, macOS or Linux, and a Pi host. Public API contracts are tested against Pi 1.1.0. `node-pty` 1.2.0-beta.15 is an optional native dependency: pipes work without it, but `tty:true` fails explicitly if its binding cannot load. This exact upstream prerelease fixes the macOS helper's missing execute permission in stable 1.1.0; no runtime permission repair is needed. A source build may need a C/C++ toolchain, Python, and Node headers. Review npm's lifecycle-script policy if native installation is disabled.

Do not load another extension that registers `bash` or `write_stdin` at the same time. This override delegates to the built-in executor, not another extension's bash override. It does not replace user `!`/`!!` execution or Pi's RPC control-channel shell command.

If you configure a restricted tool set, include `bash` to expose the unified interface (also when using codemode-only presentation). The extension does not reactivate an excluded built-in tool.

## Tools

### Choose by dependency, not command duration

| Mode | Use when | Result |
| --- | --- | --- |
| `foreground` (default) | The next action needs the result, or no useful independent work remains | Wait for the final result; no extra completion message |
| `background` | Finite work can overlap independent actions | Return promptly; automatically deliver final output to the current task |
| `service` | A server, watcher or other indefinite process should stay running | Return promptly; no automatic completion turn |

Do not edit a command's inputs while validation reads them. Re-run validation after relevant edits. `input_changes_observed` is a conservative warning that Pi's `edit`, `write` or `apply_patch` tools ran during the command; it is not a filesystem snapshot and cannot detect external changes.

Background mode authorizes additional provider usage. Results are batched into the next safe continuation, or one idle continuation when ready. They are labeled as untrusted command data, stored in the normal session transcript with `display:false`, and not printed as process bookkeeping. Direct final-result observations can consume delivery. A new user prompt, queued direction change, or abort disarms older task subscriptions without stopping the jobs. Use `process_output` or `process_wait` if you still need their results. Status listing alone does not acknowledge output.

If no independent work remains, use one event-driven wait or end the response and allow completion to resume the task. Do not repeatedly poll, sleep, or read logs just to check status. Service startup is not readiness: inspect useful output or perform an explicit readiness check.

### `bash`

```json
{"command":"git status"}
```

Omit `mode` for built-in behavior: the same output, nonzero-exit errors, truncation, effective `shellPath`/`shellCommandPrefix` settings, and optional `timeout` in seconds, with no default timeout. These calls are not retained in `/processes`.

Set `mode` explicitly for managed processes:

```json
{"command":"npm test","mode":"background","title":"Run tests","timeout":600}
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `command` | required | Shell command |
| `mode` | omitted | Omitted: built-in bash. Explicit `foreground`, `background`, or `service`: managed execution |
| `timeout` | no default for built-in; managed `1800` / service `86400` | Seconds. Managed range: 0.1 to 86,400 seconds |
| `title` | command preview in UI | Short human-readable title, at most 160 characters; never include credentials |
| `workdir` | Pi cwd | Directory, resolved relative to Pi cwd |
| `tty` | `false` | Allocate a 120×40 PTY instead of pipes |
| `max_output_tokens` | `4000` | Approximate output budget: four UTF-8 bytes per requested token, capped at 64,000 bytes; also bounds the completion tail when enabled |

`title`, `workdir`, `tty`, and `max_output_tokens` require an explicit `mode`. Managed commands are limited to 65,536 characters. Do not use `cmd`, `timeout_ms`, or `max_output_chars` with `bash`. Do not append `&` to managed commands: the runtime owns their lifetime and process group.

Initial background results include `completion_delivery:"automatic"` only when a task subscription is armed; otherwise they report `"manual"`. Running foreground/service results report `"manual"`. This is also available to codemode, not only in explanatory text. A background job that finishes before startup returns still has coordinated delivery: direct final observations consume it, but a discarded nested result cannot silently lose it. If task replacement or the 32-subscription ceiling prevents arming, use one `process_wait` when the result is required. Retained-record admission also fails safely when all slots are live or pinned by readers instead of exceeding the storage/record cap.

Queued user input releases an attached foreground wait with `status:"running"` and `wait_status:"interrupted_by_input"` without killing the command. Handle the new direction before waiting again. Explicit tool cancellation still terminates a command during its initial call.

Managed execution uses `/bin/bash --noprofile --norc -c` on Linux and `/bin/zsh -f -c` on macOS. Neither uses login-shell initialization. Ordinary calls retain the host's built-in shell selection and behavior. Commands inherit Pi's environment and filesystem/network permissions. Managed pipe stdin is closed. stdout/stderr are merged by arrival, not guaranteed to preserve ordering between streams.

### `write_stdin`

```json
{"session_id":"<PTY id>","chars":"approved input\n"}
```

Empty `chars` polls without input approval. Non-empty `chars` requires `tty:true` and a separate confirmation for that exact input. Input is capped at 4,096 characters. Control characters are shown escaped in the prompt. TUI and RPC confirmation are supported; print/JSON sessions block non-empty writes. Dialog failure, rejection, timeout, or cancellation blocks the write.

Empty polls default to one second and cap at five minutes. Input writes default to 250 ms and cap at 30 seconds. `max_output_tokens` uses the same approximate byte budget as startup.

Calls for the same process serialize, including input approval; different process sessions run concurrently. Each poll consumes the next output segment. Cancelling a poll leaves the process running; use `process_kill` to stop it. Cancelling the initial managed `bash` wait terminates that newly created process.

### `process_output`

```json
{"session_id":"<id>","cursor":0,"max_output_tokens":4000}
```

Read useful partial or final output immediately. Reads are non-consuming: use the returned `next_cursor` for incremental segments without interfering with other readers, the model completion tail or the UI. `cursor` counts raw bytes before terminal sanitization. `dropped_bytes` reports bytes not stored because of log quotas or disk failures; `unread_bytes` counts remaining retained bytes.

The transport decodes stdout/stderr as UTF-8 before retention; malformed bytes become replacement characters. Cursors count this decoded UTF-8 stream, not a binary-exact original byte stream.

Set `tail:true` to inspect the latest output, including after log quota exhaustion. Tail reads have `output_scope:"tail"` and no cursor; do not combine them with a nonzero cursor. Normal reads have `output_scope:"log"`.

Inside codemode, a script can discard a nested result. Set `acknowledge:true` when the script intentionally handles the final result and should consume automatic delivery; otherwise the coordinator will still deliver it to the model. Direct finalized reads acknowledge only final results with no unread retained bytes.

### `process_wait`

```json
{"session_ids":["<id-a>","<id-b>"],"until":"all","timeout_ms":1800000}
```

One event-driven dependency wait for up to eight processes. `until` is `all` (default) or `any`. The wait returns immediately when its condition is met, at its deadline, or when user input is queued. `wait_status` is `completed`, `deadline`, or `interrupted_by_input`. Tool cancellation leaves processes running.

Output budgets apply across the selected processes. Results are non-consuming log reads, so large output can require `process_output` cursors or a tail read. Nested calls support the same explicit `acknowledge` contract. Do independent work before waiting; do not implement a repeated model polling loop.

### `process_list` and `process_kill`

`process_list({})` lists retained IDs and status without consuming output. `process_kill({"session_id":"..."})` sends SIGTERM to the owned POSIX process group, escalates to SIGKILL after 500 ms, and returns remaining bounded output. Intentional stops report `stopped:true`; timeouts and unexpected signals remain failures. You cannot supply an arbitrary PID. Model reads, acknowledgments of automatic delivery, and control calls never acknowledge human attention.

### Results and retention

Every managed execution/poll result includes:

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

Each process retains the latest 1 MiB of unread legacy polling output, an independent 64,000-byte latest-output tail, and up to 8 MiB of raw output in private temporary storage. Disk storage is capped at 32 MiB per runtime; overflow is explicit, not a complete archive. Temporary directories/files use 0700/0600 permissions. At most 32 records are retained; older completed records without pending human attention or active readers can be evicted as new jobs start. Unacknowledged failures are not silently evicted. If all slots are protected, acknowledge or remove completed records before starting more. Output logs are removed on explicit cleanup, eviction, and orderly teardown. SIGKILL/crash can leave temporary logs behind; there is no restart recovery. See SECURITY for the sensitive-data implications.

Ordinary foreground execution and services create no completion message. Explicit background mode delivers bounded output through the task coordinator. Completion context never attaches command or PTY input arguments, although output can echo either. The completion tail uses the initial `max_output_tokens` byte budget (16,000 bytes by default; maximum 64,000 bytes). It is independent of polling and log reads, and can duplicate output already read.

Pushed output is explicitly labeled as untrusted command data, not instructions. It can contain secrets or prompt injection. Select background mode only for output you intend to send to your model provider and store in Pi's normal session transcript. Shutdown and reload suppress completion delivery from processes they terminate.

### Background process widget

In interactive Pi, live background processes appear above the editor:

```text
Background processes · 2
  7036d2a5 · background · pipe · 12s · npm test
  b50d91ce · service · PTY · 4s · read -r answer
/processes: output and stop controls
```

Only processes whose initial call returned `running` appear. Foreground calls and completed records do not occupy the widget. Membership changes immediately on process exit, kill, or timeout, without polling or a model turn. Elapsed time refreshes once per second while jobs remain. The widget disappears when the last job exits and clears on reload, shutdown, or session replacement.

Each command preview is bounded to the first 256 UTF-16 code units, escapes terminal controls and direction-changing Unicode characters, and truncates to the available terminal width. It is a preview, not a full command or safety decision. Commands can contain secrets; do not place credentials in command arguments. No process output or submitted PTY input is displayed or consumed by the widget.

The widget shows at most three process rows plus an overflow count. Successful completion and intentional stops give five seconds of footer feedback. Managed failures (including explicit foreground failures), unexpected signals, and timeouts leave an attention count until explicitly acknowledged or removed. Other extensions' widgets, editor, and footer remain unchanged. RPC, print, and JSON modes do not create terminal components; their structured tools and automatic result delivery still work. Print/JSON callers must keep the host alive for idle auto-resume, or use foreground/`process_wait` before exiting.

### Live `/processes` manager

`/processes` opens one live screen, not nested selection menus. Attention items sort first, followed by running work and completed history. Rows show title, mode, status, duration, ID prefix, and acknowledgment state. Selection stays on the same process when the list reorders. The screen updates on lifecycle events, coalesces output changes to at most ten UI refreshes per second, and refreshes elapsed time once per second.

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select a process; scroll output one line |
| Page Up / Page Down | Move one page |
| Enter | Open selected output |
| Esc | Return from output to the list; close from the list |
| `f` | Toggle live output following; scrolling pauses it |
| ← / → | Pan output by ten columns |
| `n` / `p` | Next/previous retained log segment |
| `t` | Latest-output snapshot without following; `p` returns to the prior log segment |
| `r` | Refresh the current log segment or tail |
| `a` / `A` | Acknowledge selected/all current failures |
| `s` | Stop selected running process; retain its output |
| `d` / `D` | Remove selected/all completed records and their output |
| `?` | Scrollable help |

Stop and removal actions show an inline confirmation: `y` confirms and Esc cancels. Completed cleanup snapshots its targets, never stops running work, and skips records with active readers or stop operations. Opening output pins that record against eviction without consuming output or delaying automatic model delivery. Follow starts off; paused output moves only when you navigate or refresh.

Execution and attention are independent: a failed process remains failed after acknowledgment. Viewing output does not acknowledge a failure, and viewing or acknowledging a running process cannot suppress a future failure. Acknowledgment retains output and does not change model delivery. Stopping or removing a record cancels pending automatic delivery for that record; already-delivered session content cannot be retracted. Human attention is not changed when the model reads or handles results.

Human attention and its eviction protection apply only in terminal mode. Print, JSON, and RPC sessions retain normal bounded-record eviction and never require an unavailable terminal acknowledgment.

Opening the process panel does not change the model task. Navigating to another session-tree branch disarms task subscriptions; retained process controls remain available.

Tool results, including empty legacy `write_stdin` polls, show status and loss counts plus the first four output lines. Expansion shows at most 40 lines; long lines are clipped to terminal width. Model output budgets are independent of this display limit. Use the process panel for full retained segments and long-line navigation.

Completion feedback uses a footer status, not `ui.notify()` or visible conversation entries. Failed-result attention remains until explicitly acknowledged or removed, not merely inspected. Carriage-return progress and tabs are normalized for display without changing model output or raw retained logs.

## Command policy

Use the matching checkout of `pi-dcg` for the unreleased unified interface. It checks `bash.command` in the resolved `workdir` and seals all arguments, including execution mode, against later mutations. Published guards do not yet account for managed bash working directories.

DCG is optional and inherits its configured fail-open/fail-closed policy. Set `PI_DCG_ON_ERROR=block` for bridge failures to block startup. Without a guard extension, startup follows Pi's normal local-tool behavior; this package does not add a startup confirmation.

**DCG cannot safely validate partial interactive input.** The per-write confirmation is a separate human decision, not a DCG allow decision. Approving input can execute destructive commands or alter a shell's state. Bash hooks apply to the unified entry point, but must account for managed `workdir` and mode. They do not automatically cover `write_stdin`. The Pi 1.1.0 earlier-input-object replacement limitation described in pi-dcg also applies.

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
2. Start `printf 'ready\n'; sleep 3; printf 'done\n'` with `mode:"background"`. Continue other work and verify automatic result delivery.
3. Start `read -r answer; printf '%s\n' "$answer"` with `mode:"service"` and `tty:true`. Reject one input write, then approve `hello\n`. Verify only the approved write reaches the process.
4. Start `sleep 60 & wait`, stop its ID, and verify both shell and child exit.
5. Start another sleeper, then reload or switch sessions. Verify it exits and its old ID is unavailable.
6. Run one finite command in background mode. Verify one output-bearing completion continuation. Repeat in service mode and verify no unsolicited model turn.
7. Repeat input rejection/approval with an RPC client that implements Pi's extension UI protocol.
8. In interactive Pi, start two sleepers in service mode. Verify both appear above the editor while Pi is idle and their elapsed times advance. Kill one and verify the count drops. Let the other finish without polling and verify the widget disappears. Repeat with a foreground command and verify no widget appears.
9. While a background process is visible, resize the terminal and switch between light, dark, and system themes. Verify lines fit, the editor remains usable, and other extensions' widgets remain present. Repeat in regular and fullscreen modes.
10. Start `sleep 3; printf 'test failed\n'; exit 7` with `mode:"background"`. Leave Pi idle. Verify the next model turn receives the exit code and output without polling. Read afterward and verify the output remains available. Repeat while Pi is doing other work.

The widget uses public Pi UI APIs. No editor/footer replacement or private Pi API patch is used.

Additional smoke checks for the execution modes and process UI:

0. Call `bash` with only `command`, then with `timeout` in seconds. Verify built-in output and nonzero-exit errors. Call `bash` with explicit foreground/background/service modes, verify process IDs and `/processes`, and verify a managed `workdir` is checked by DCG in that directory. Confirm `exec_command` is not registered or callable.
1. Start a finite background test with a title, then do independent read-only work. Verify the result reaches the next safe continuation without polling or a visible JSON completion card.
2. Start two independent foreground commands in one tool batch. Verify their lifetimes overlap; do not use concurrently mutating validation inputs.
3. Start an indefinite service. Verify it returns promptly, stays inspectable in `/processes`, and does not auto-resume on exit or claim readiness.
4. Run a command with hundreds of output lines, then use a legacy empty `write_stdin` poll. Verify four collapsed output lines, bounded expansion, status/loss counts and narrow-terminal clipping.
5. Inspect it through `/processes`. Verify line/page scrolling, horizontal columns, next/previous log segments, tail, refresh, and follow/pause. Verify Esc returns to the list before closing. Confirm this makes no model request and does not consume tool output or delay automatic delivery.
6. Queue a steering message during a long foreground attachment or `process_wait`. Verify prompt release without process termination. Change task or session-tree branch before background completion and verify no stale wake.
7. Repeat a nested wait in codemode while discarding its result; verify automatic model delivery still occurs. Repeat with `acknowledge:true` while handling the result and verify no duplicate.
8. View a running job, then let it fail. Verify attention appears. View its output again and verify attention remains until `a`. Repeat with `A` and verify a later failure still alerts.
9. Cancel then confirm `s`, `d`, and `D`. Verify stops retain output, removal deletes only completed records, running work survives bulk cleanup, and protected readers are skipped. Verify warning counts and recent footer feedback clear with the removed records.
10. In regular and fullscreen modes, resize the manager, switch themes, use custom selection keybindings, and open help. Verify rows stay bounded and close/reload removes UI timers and retention pins.

Automated tests use a scripted provider to verify Pi scheduling and serialization without credentials. They prove execution/delivery contracts, not that every model will choose optimal parallel work. For a live-model acceptance pass, compare independent work before waiting, empty-poll counts, duplicate reports, result latency, correctness after edits, and task time/token use across the models you use.

To check another installed SDK without using credentials or live inference:

```bash
node --import tsx packages/pi-processes/tests/host-smoke.mjs /path/to/installed/pi-coding-agent/dist/index.js
```
