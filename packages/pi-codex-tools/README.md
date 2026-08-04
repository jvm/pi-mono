# pi-codex-tools

Give grammar-capable OpenAI/Codex models the Codex `apply_patch` tool in Pi without changing Pi's normal tools for other models.

## What it adds

- **Raw `apply_patch`** — sends Codex's Lark grammar as an OpenAI custom tool, so patches are not JSON-wrapped.
- **Capability-based activation** — requires `openai-codex-responses` or `openai-responses` plus `model.compat.supportsOpenAIGrammarTools === true`; model names alone are never enough.
- **Safe local mutation** — patches are limited to 1 MiB, target files to 64 MiB, stay under Pi's current working directory, reject symlink escapes, use descriptor-anchored no-follow operations on Linux, fail closed elsewhere, preflight all hunks, and serialize writes with Pi's mutation queue.
- **Model switching** — supported models replace Pi's `edit` and `write` tools with `apply_patch`; other active tools are preserved. Switching back restores only the file tools that were active before the switch.
- **Sequential patch calls** — the extension marks patch execution sequential and disables provider-side parallel tool calls when the patch tool is active.

## Installation

```bash
pi install npm:pi-codex-tools
```

For a one-off run:

```bash
pi -e /path/to/pi-mono/packages/pi-codex-tools
```

## Scope decisions

The current Codex source does not define separate `read_file` or `write_file` tools: file inspection is normally done through shell commands and file mutation through `apply_patch`. This package keeps Pi's bounded `read` and `bash` tools, and uses `apply_patch` in place of Pi's `edit` and `write` tools for supported models. Because Pi does not provide Codex's OS-level filesystem sandbox, `apply_patch` runs only on Linux and fails closed on unsupported platforms. It also requires a Pi model runtime that advertises `compat.supportsOpenAIGrammarTools`; older runtimes leave the tool inactive.

| Codex surface | Decision |
| --- | --- |
| `apply_patch` | Included; it is a materially different freeform grammar tool. |
| `shell_command` | Deferred; Pi already has the bounded shell backend, while a faithful adapter needs Codex's approval and working-directory contract. |
| `exec_command` + `write_stdin` | Deferred; persistent PTY sessions need a separate process/session design. |
| `view_image` | Deferred; Pi's `read` already sends supported images as attachments. |
| `update_plan` | Deferred; it is workflow metadata rather than a capability-specific file tool. |
| Code Mode `exec` + `wait` | Deferred; it requires a real sandbox for model-authored JavaScript, not Node's ordinary `vm` wrapper. |

These choices are based on the Codex tool specifications in `codex-rs/core/src/tools`, the model profiles in `codex-rs/models-manager/models.json`, and the Code Mode protocol. They intentionally keep this package focused on the one tool with a distinct transport and model-facing contract.

## Compatibility notes

`apply_patch` is line-oriented rather than byte-oriented:

- `*** Add File` requires at least one `+` line and writes a trailing newline. A `+`-only hunk creates a one-newline file, not a zero-byte file.
- Updates produce a trailing newline for non-empty output, so updating a file that lacks one may add it.
- Existing CRLF line endings are preserved when detected.
- Use `bash` when exact byte-level output or a truly empty file is required.

These behaviors intentionally match Codex `apply_patch`.

The provider contract is runtime-specific: use Pi 0.83.0 or newer for OpenAI grammar-tool support. For a manual smoke test, start Pi with this extension and a model that advertises `supportsOpenAIGrammarTools`, then verify that a file change appears as an `apply_patch` call and not as `edit`, `write`, or `bash`.

## Development

```bash
npm run -w packages/pi-codex-tools check
npm test -w packages/pi-codex-tools
npm run -w packages/pi-codex-tools pack:dry-run
```

Install/update telemetry is disabled in CI and can be disabled with `PI_OFFLINE=1`, `PI_TELEMETRY=0` or `PI_TELEMETRY=false`, or Pi's `enableInstallTelemetry: false` setting. See [SECURITY.md](./SECURITY.md).

## License

This package is Apache-2.0 licensed because its grammar/parser behavior is adapted from OpenAI Codex. See [NOTICE](./NOTICE).
