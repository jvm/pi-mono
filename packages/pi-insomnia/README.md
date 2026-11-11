# pi-insomnia

Keep long-running [Pi](https://pi.dev) tasks alive when you step away from your Mac or Linux machine.

`pi-insomnia` automatically prevents idle system sleep while Pi is working, then releases the sleep assertion as soon as the agent fully settles. No commands or manual activation needed.

> [!WARNING]
> Pi packages can execute arbitrary code through extensions. Review package source before installing any third-party Pi package.

## Features

- **Automatic protection** — inhibit idle sleep only while Pi has active work.
- **Full-run awareness** — stay awake through retries, compaction, and queued follow-up work, then release when Pi settles.
- **Automatic setup** — use macOS built-in `caffeinate` or Linux `systemd-inhibit`; no commands, behavior configuration, or third-party runtime dependency.
- **Compact state** — show one coffee-cup icon in the TUI footer while sleep inhibition is active.
- **Safe cleanup** — release assertions on session shutdown, reload, and quit.

The icon is palette-neutral and is absent in print, JSON or RPC
mode. Sleep inhibition itself follows the same active-work lifecycle in all modes.

### Footer icon

The footer uses **󰅶** (`nf-md-coffee`, `U+F0176`) only while sleep inhibition
is active, and clears it when the agent settles or the session shuts down.
There is no spinner, animation timer, or text fallback.

Configure the terminal to use **Nerd Font 3 or later**, preferably its **Mono**
variant for single-cell alignment. Pi does not install fonts or detect missing
glyphs; an unsupported font may display a box. Font support affects only the
indicator, not sleep inhibition.

## Platform support

`pi-insomnia` supports macOS and Linux with systemd-logind. On other platforms it silently no-ops.

### macOS

On macOS, the extension launches:

```bash
/usr/bin/caffeinate -i -w <pi-pid>
```

`-i` prevents idle system sleep while the process is running. `-w <pi-pid>` also ties the assertion to the Pi process so the helper exits if Pi exits unexpectedly. The extension still explicitly terminates the helper when Pi becomes fully idle after any automatic retries, compaction retries, or queued follow-up work.

### Linux

On Linux, the extension launches `/usr/bin/systemd-inhibit` (or `/bin/systemd-inhibit`):

```bash
systemd-inhibit --what=idle:sleep --who=pi-insomnia --why="Pi agent is working" \
  --mode=block --no-ask-password /usr/bin/cat
```

The lock blocks idle handling and suspend/hibernate, not shutdown. `systemd-inhibit` holds it until `cat` exits. `cat` reads a pipe from Pi, so the lock ends when the extension terminates the helper on settle or shutdown, and also when Pi exits unexpectedly and the pipe closes.

If `systemd-inhibit` is not installed, or logind refuses the lock (for example in a remote SSH session where polkit requires interactive authentication, or in a container without logind), the extension shows one warning in the TUI and stays inactive for the rest of the session. It never prompts for a password. Print, JSON, and RPC modes show no notice.

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

`pi-insomnia` has no behavior configuration. If the package is installed and Pi is running on macOS or Linux, sleep inhibition is automatic while the agent is working.

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

Footer smoke test on macOS: select a Nerd Font Mono, start an agent request,
and check that the coffee cup appears while work is active and disappears when
the agent settles. Repeat at narrow and wide terminal widths and in light and
dark Pi themes. Shutdown during active work must release sleep inhibition.
