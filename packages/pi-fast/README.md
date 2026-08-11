# pi-fast

Use provider fast modes in Pi when you need lower latency, while keeping the paid path off by default.

`pi-fast` currently supports OpenAI Codex models that advertise Fast processing. It adds Codex's `priority` service tier after you enable it for the session or opt in to the global default.

## Features

- **On-demand toggle** — use `/fast`, `/fast on`, `/fast off`, or `Ctrl+Shift+F`.
- **Safe model guard** — only supported `openai-codex` models receive the Fast request field.
- **Visible state** — the Pi footer shows `Fast on`, `Fast off`, or `Fast n/a`.
- **Configurable default** — opt in once to start Fast mode on for every supported model.
- **Session-local overrides** — command and shortcut changes reset to the configured default for each session.

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

Fast mode remains off by default. To start every session with Fast mode enabled for all supported models, add this setting to Pi's global `settings.json` (normally `~/.pi/agent/settings.json`, or the configured agent directory):

```json
{
  "pi-fast": {
    "enabledByDefault": true
  }
}
```

This is a global opt-in because the `priority` service tier can increase provider usage. Unsupported provider/model pairs remain unchanged. `/fast off` disables Fast mode for the current session; starting, switching, or reloading a session restores the configured default.

Install/update telemetry can be disabled with `PI_OFFLINE=1` or `PI_TELEMETRY=0`.

## Development

```bash
npm install
npm run -w packages/pi-fast check
npm test -w packages/pi-fast
npm run -w packages/pi-fast pack:dry-run
```
