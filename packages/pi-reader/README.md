# pi-reader

Convert HTTP(S) URLs and readable local files to Markdown or structured JSON for Pi.

## Features

- Pi tool: `reader_convert`
- Pi slash command: `/reader`
- CLI command: `pi-reader`
- Inputs: web URLs, HTML files, Markdown, plain text, and JSON
- Outputs: Markdown or JSON, inline or written to a file
- Safer URL fetching: blocks localhost/private network targets, rejects credentialed URLs, disables redirects, enforces a timeout, and caps input size

## Installation

```bash
pi install npm:pi-reader
```

For local development:

```bash
pi install /path/to/pi-mono/packages/pi-reader
```

## Pi tool

Ask Pi to convert a URL or file:

```text
Convert https://example.com to markdown and save it as example.md
```

The registered tool is `reader_convert` with parameters:

- `input`: HTTP(S) URL or local file path
- `format`: `markdown`, `md`, or `json` (default: `markdown`)
- `output`: optional path to write
- `overwrite`: replace an existing output file when true

## Slash command

```text
/reader https://example.com --format markdown --output example.md
/reader ./article.html --format json --output article.json --overwrite
```

If `--output` is omitted, `/reader` writes `reader-output.md` or `reader-output.json` in the current working directory.

## CLI

```bash
pi-reader https://example.com --format markdown --output example.md
pi-reader ./article.html --format json > article.json
```

## Supported inputs

- URLs with `http` or `https`
- HTML (`.html`, `.htm`, `text/html`): extracted with Mozilla Readability, converted with Turndown
- Markdown/text (`.md`, `.markdown`, `.txt`): passed through
- JSON (`.json`, `application/json`): pretty-printed for Markdown and wrapped for JSON output
