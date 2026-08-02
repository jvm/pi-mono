# pi-fast

Use provider fast modes in Pi when you need lower latency, while keeping the paid path off by default.

`pi-fast` currently supports OpenAI Codex models that advertise Fast processing. It adds Codex's `priority` service tier only after you explicitly enable it for the session.

## Features

- **On-demand toggle** — use `/fast`, `/fast on`, `/fast off`, or `Ctrl+Shift+F`.
- **Safe model guard** — only supported `openai-codex` models receive the Fast request field.
- **Visible state** — the Pi footer shows `Fast on`, `Fast off`, or `Fast n/a`.
- **Session-local behavior** — Fast mode starts off and is never persisted.

## Supported models

The current OpenAI Codex catalog advertises Fast support for:

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.6-terra`

The support list follows the upstream Codex model catalog and may need an update when that catalog changes. Models without an advertised Fast tier are left untouched.

## Installation

Install from npm:

```bash
pi install npm:pi-fast
```

Install project-locally with Pi's `-l` flag:

```bash
pi install -l npm:pi-fast
```

During local development from this monorepo:

```bash
pi install /path/to/pi-mono/packages/pi-fast
```

For a one-off run without installing:

```bash
pi -e /path/to/pi-mono/packages/pi-fast
```

This is an npm-compatible TypeScript Pi package. There is no runtime build step.

## Usage

Start a supported Codex model, then use either:

```text
/fast
```

or press `Ctrl+Shift+F`.

`/fast` toggles the current state. `/fast on`, `/fast off`, and `/fast toggle` select it explicitly. When active, supported Codex requests include `service_tier: "priority"`, which upstream describes as faster processing with increased usage.

## Configuration

There is no Fast-mode configuration. The mode is intentionally disabled when Pi starts and resets when the extension reloads or the session ends.

Install/update telemetry can be disabled with `PI_OFFLINE=1` or `PI_TELEMETRY=0`.

## Development

```bash
npm install
npm run -w packages/pi-fast check
npm test -w packages/pi-fast
npm run -w packages/pi-fast pack:dry-run
```
