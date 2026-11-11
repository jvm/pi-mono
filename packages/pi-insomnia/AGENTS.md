# pi-insomnia Guidelines

Root `AGENTS.md` applies.

## Invariants

- Behavior stays automatic and command-free unless explicitly redesigned.
- Spawn `/usr/bin/caffeinate` (macOS) or `systemd-inhibit` from a fixed absolute path (Linux) directly with fixed arguments; never use shell interpolation or `PATH` lookup.
- On Linux, tie the lock to Pi with the `cat` stdin pipe and never prompt for authentication. A missing binary or refused lock shows one TUI notice, then the inhibitor stays inactive.
- Inhibit only during active agent work; release on settle, reload, shutdown, and quit.
- Platforms other than macOS and Linux remain a silent no-op.
- Tests inject the spawner; they must not require macOS or systemd.
- Show one palette-neutral Nerd Font coffee-cup icon only while inhibition is active; do not create an animation timer.

## Validation

```bash
npm run -w packages/pi-insomnia check
npm test -w packages/pi-insomnia
npm run -w packages/pi-insomnia pack:dry-run
```
