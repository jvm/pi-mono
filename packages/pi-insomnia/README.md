# pi-insomnia

A source-distributed [Pi](https://pi.dev) package that prevents macOS idle sleep while the Pi agent is working.

> [!WARNING]
> Pi packages can execute arbitrary code through extensions. Review package source before installing any third-party Pi package.

## Features

- Automatically starts a macOS sleep assertion when a Pi agent run starts.
- Automatically releases the assertion when Pi settles after all retries, compaction, and queued follow-up work.
- Cleans up on Pi session shutdown, reloads, and quits.
- Uses the macOS built-in `/usr/bin/caffeinate` command; no third-party runtime dependency is required.
- Shows a small `☕ sleep inhibited` footer status while active in UI modes.
- No slash commands, tools, or manual activation needed.

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
