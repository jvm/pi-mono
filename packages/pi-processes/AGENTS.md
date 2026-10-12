# pi-processes Guidelines

## Invariants

- `src/transport.ts` owns POSIX pipe/PTY differences; no provider overlays or private Pi APIs.
- Keep shell selection fixed: bash on Linux, zsh on macOS, no login/interactive startup flags.
- Pipes close stdin. PTY input requires approval for every non-empty write, including control characters. No bypass flag or agent-redeemable approval token.
- Serialize approval and reads/writes per process; independent processes remain concurrent.
- Bound active processes, retained records, output, input, waits, and timeouts. Report output loss explicitly.
- Initial-call cancellation stops its new process; polling cancellation stops the wait only.
- Kill session-owned process groups on timeout, shutdown, reload, and normal Node exit. Never target arbitrary model-supplied PIDs.
- Default/legacy completion messages contain status metadata only. Explicit completion modes may deliver a bounded, sanitized, untrusted output tail without consuming polling output; wake the model only when requested. Never attach command or input arguments.
- Keep the widget terminal-only, detached-process-only, and output-free. Drive membership from lifecycle events, not model/tool polling; stop its clock and clear only its own slot on teardown.
- This is local execution, not a sandbox. DCG startup coverage belongs in `pi-dcg`; never claim DCG validates incremental stdin.

## Validation

```bash
npm run -w packages/pi-processes check
npm test -w packages/pi-processes
npm run -w packages/pi-processes pack:dry-run
```

Run pipe and native PTY tests on Linux and macOS. A missing PTY binding must fail the PTY test, not silently skip it. Also test the real Pi session/codemode/DCG path. See README for the manual interactive/RPC smoke test.
