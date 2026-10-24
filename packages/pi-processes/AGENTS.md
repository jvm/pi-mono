# pi-processes Guidelines

## Invariants

- `src/transport.ts` owns POSIX pipe/PTY differences; no provider overlays or private Pi APIs.
- Ordinary `bash` calls delegate to Pi's built-in executor. Explicit modes use the managed runtime and `timeout` in seconds. Do not register a second command-execution tool.
- Keep managed shell selection fixed: bash on Linux, zsh on macOS, no login/interactive startup flags.
- Pipes close stdin. PTY input requires approval for every non-empty write, including control characters. No bypass flag or agent-redeemable approval token.
- Serialize approval and reads/writes per process; independent processes remain concurrent.
- Bound active processes, retained records, output, input, waits, and timeouts. Report output loss explicitly.
- Initial-call cancellation stops its new process; polling cancellation stops the wait only.
- Kill session-owned process groups on timeout, shutdown, reload, and normal Node exit. Never target arbitrary model-supplied PIDs.
- Foreground and service execution are silent on completion. Explicit background mode arms task-scoped delivery; keep transport facts separate from scheduling and acknowledgment. Do not queue stale task results or duplicate finalized observations.
- Never count a nested result as provider-visible without explicit acknowledgment. Expose execution modes, not host delivery mechanics.
- Bound private temporary logs, completion tails, aggregate result batches, and every visible preview. Readers and UI must not consume each other's output. Never accept caller-supplied log paths.
- Model completion messages are hidden in the visible conversation. Use renderers, lifecycle-driven status and `/processes` for human feedback; do not attach command/input arguments to completion context.
- Keep the widget terminal-only, detached-process-only, and output-free. Drive membership from lifecycle events, not model/tool polling; stop its clock and clear only its own slot on teardown.
- Keep human attention separate from output inspection and model completion acknowledgment. Protect unacknowledged failures from eviction; intentional stops are not failures.
- The live manager uses local, bounded reads. UI retention pins must not delay model delivery. Confirm stop/removal, delete only completed unpinned owned output, and release subscriptions/timers/pins on close.
- This is local execution, not a sandbox. DCG startup coverage belongs in `pi-dcg`; never claim DCG validates incremental stdin.

## Validation

```bash
npm run -w packages/pi-processes check
npm test -w packages/pi-processes
npm run -w packages/pi-processes pack:dry-run
```

Run pipe and native PTY tests on Linux and macOS. A missing PTY binding must fail the PTY test, not silently skip it. Also test the real Pi session/codemode/DCG path. See README for the manual interactive/RPC smoke test.
