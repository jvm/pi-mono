# pi-insomnia

Keep long-running [Pi](https://pi.dev) tasks alive when you step away from your Mac.

`pi-insomnia` automatically prevents idle system sleep while Pi is working, then releases the sleep assertion as soon as the agent fully settles. No commands or manual activation needed.

> [!WARNING]
> Pi packages can execute arbitrary code through extensions. Review package source before installing any third-party Pi package.

## Features

- **Automatic protection** — inhibit idle sleep only while Pi has active work.
- **Full-run awareness** — stay awake through retries, compaction, and queued follow-up work, then release when Pi settles.
- **Zero setup** — use macOS built-in `caffeinate`; no commands, configuration, or third-party runtime dependency.
- **Visible state** — show a small `☕ sleep inhibited` footer status while active.
- **Safe cleanup** — release assertions on session shutdown, reload, and quit.

## Platform support

`pi-insomnia` currently targets macOS. On non-macOS platforms it silently no-ops.

On macOS, the extension launches:

```bash
/usr/bin/caffeinate -i -w <pi-pid>
```

`-i` prevents idle system sleep while the process is running. `-w <pi-pid>` also ties the assertion to the Pi process so the helper exits if Pi exits unexpectedly. The extension still explicitly terminates the helper when Pi becomes fully idle after any automatic retries, compaction retries, or queued follow-up work.

## Installation

Install from npm:

```bash
pi install npm:pi-insomnia
```

Install project-locally with Pi's `-l` flag:

```bash
pi install -l npm:pi-insomnia
```

During local development from this monorepo:

```bash
pi install /path/to/pi-mono/packages/pi-insomnia
```

For a one-off test run without installing:

```bash
pi -e /path/to/pi-mono/packages/pi-insomnia --print "explain what this package does"
```

This is an npm-compatible TypeScript Pi package. There is no runtime build step.

## Configuration

| Variable | Purpose |
|---|---|
| `PI_OFFLINE=1` | Disables install/update telemetry. |
| `PI_TELEMETRY=0` | Disables install/update telemetry. |

`pi-insomnia` has no behavior configuration. If the package is installed and Pi is running on macOS, sleep inhibition is automatic while the agent is working.

## Notes

- The extension inhibits idle system sleep, not display sleep. It does not use `caffeinate -d`.
- The extension does not request elevated privileges.
- On startup, Pi Insomnia sends a best-effort install/update telemetry ping once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI.

## Development

```bash
npm install
npm run check
npm run pack:dry-run
```
