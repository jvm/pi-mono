# pi-codex-tools

Give grammar-capable OpenAI/Codex models the Codex `apply_patch` tool in Pi without changing Pi's normal tools for other models.

## What it adds

- **Raw `apply_patch`** — sends Codex's Lark grammar as an OpenAI custom tool, so patches are not JSON-wrapped.
- **Model-only exposure** — `apply_patch` is available directly to the model, never through codemode or other nested tool calls. Requires Pi 0.99.1 or newer.
- **Capability-based activation** — requires `openai-codex-responses` or `openai-responses` plus `model.compat.supportsOpenAIGrammarTools === true`; model names alone are never enough.
- **Pi-style filesystem access** — accepts relative or absolute paths and follows symlinked files and directories, including macOS `/tmp`. Uses Node filesystem APIs without a native binding or platform gate.
- **Validated patches** — limits patches to 1 MiB and target-file reads to 64 MiB, preflights all hunks, and serializes writes with Pi's mutation queue.
- **Native editing through codemode** — supported models see `apply_patch` instead of native `edit` and `write` declarations. Selected native tools remain active and callable through codemode, without replacing their implementations. Model switches and reloads preserve tool selection and approval wrappers. Keep your usual `defaultTools` selection; no separate exposure extension is needed.
- **Sequential patch calls** — the extension marks patch execution sequential while leaving provider-side parallel tool calls enabled.
- **Streaming progress** — while a patch is generated, the TUI shows a live, color-coded glimpse of the content being written (new-file content, or `+`/`-` lines for updates) plus a running `+added -removed` tally and a per-file roster for multi-file patches. It reuses Pi's shared diff rendering and mirrors the built-in `write`/`edit` previews; patch execution is unchanged.

## Installation

```bash
pi install npm:pi-codex-tools
```

For a one-off run:

```bash
pi -e /path/to/pi-mono/packages/pi-codex-tools
```

## Scope decisions

The current Codex source does not define separate `read_file` or `write_file` tools: file inspection is normally done through shell commands and file mutation through `apply_patch`. This package keeps Pi's bounded `read` and `bash` tools, and presents `apply_patch` in place of native `edit` and `write` declarations for supported models. Filesystem access uses the local user's permissions, like native Pi tools; it is not a sandbox. `apply_patch` requires a Pi model runtime that advertises `compat.supportsOpenAIGrammarTools`; older runtimes leave the tool inactive.

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

The Pi 1.1.0 metadata contract groups `apply_patch` under `codex_files`, without
renaming it or changing exposure. Its advisory hints are mutating, destructive,
non-idempotent, and local-only. There is no public output schema: it intentionally
remains model-only, not discoverable/callable from scripts. Metadata does not
replace approvals or change native file-tool implementations.

While this package's `apply_patch` is active on Pi 0.99.1 or newer, its public
`prepareLoadout` hook hides selected native `edit` and `write` declarations from
model requests. The tools keep their original implementations and `direct`
exposure, and remain in `pi.getActiveTools()`. Activate `codemode` to call them
from scripts; `describeTool("edit")` and `describeTool("write")` provide their
schemas. The `apply_patch` description points to these helpers when codemode is
active, including in codemode's `on` mode where direct tools are not listed
inline.

Explicitly activating a native file tool makes it callable but does not reveal
its declaration while `apply_patch` is active. Deactivating it removes nested
access too. Switching to an unsupported model stops hiding native declarations;
other loadout hooks, such as codemode's `only` mode, still apply. Reloads preserve
the active selection without a package-owned snapshot.

Tools omitted from `defaultTools` or an explicit `--tools` selection are not
introduced into codemode. Other extensions' file-tool implementations, including
approval wrappers registered during or after `session_start`, are not replaced
or hidden by this package. If another extension replaces `apply_patch`, this
package's loadout hook does not apply to that replacement.

Older Pi runtimes without exposure metadata retain the legacy behavior:
supported models replace active file tools with `apply_patch`, without
registering codemode overrides. They do not offer this package's nested native
editing route; upgrade Pi for that capability. The fallback restores its saved
file-tool selection when leaving supported models. Older Pi cannot distinguish
an explicit deactivation of an already-hidden tool from leaving it unchanged.
To disable such a tool, switch to an unsupported model before changing the
selection, or upgrade Pi to preserve explicit deactivation while `apply_patch`
is active.

### GPT-6 Astra

A Pi 1.1.0 virtual-model selection does not advertise the physical request's
grammar capability to this extension. `apply_patch` stays unavailable even when
the router chooses Astra; selected native `edit` and `write` declarations remain
available, subject to other loadout hooks. The extension does not infer support
from a virtual model name or reactivate excluded tools.

Pi 0.85.1's model catalog advertises grammar-tool support for `gpt-6-astra` on both `openai-responses` and `openai-codex-responses`. The extension uses that capability directly, with no model-name allowlist or JSON wrapper. Tests cover the pinned Pi transports, streamed raw calls, execution, and result replay using mocked HTTP responses; they do not certify live account access.

The [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra) also describes async tool calls, mid-turn steering, and reasoning updates. Those belong to the provider/session runtime and are not enabled by this extension. Patch execution remains sequential; provider-side parallel tool calling remains enabled.

With `pi-codex-compaction` installed, public server-side compaction uses Pi's
ordinary effective request, including this tool's grammar, calls and results.
The former direct-compaction grammar event-bus adapter has been removed.
No private Pi registry is patched.

### Filesystem behavior

- Add and update follow file symlinks and preserve the links. Add can create the target of a dangling symlink.
- Symlinked parents work for add, update, delete, and move, including paths outside the current directory.
- Delete removes the named entry. Deleting a symlink leaves its target unchanged.
- Move writes the updated content to the destination, then removes the source entry. A symlink destination is followed; a symlink source is removed without deleting its target.
- Preflight shares virtual content across symlink aliases and rejects moves onto the same resolved target.
- Symlink loops are rejected.
- Patches operate on regular text files, not directories, devices, sockets, or pipes.

Like native Pi tools, normal path-based I/O does not protect against another process replacing a path during execution. Preflight is not a transaction; an I/O failure can leave earlier files changed. See [SECURITY.md](./SECURITY.md).

### Text format

`apply_patch` is line-oriented rather than byte-oriented:

- `*** Add File` requires at least one `+` line and writes a trailing newline. A `+`-only hunk creates a one-newline file, not a zero-byte file.
- Updates produce a trailing newline for non-empty output, so updating a file that lacks one may add it.
- Existing CRLF line endings are preserved when detected.
- Use `bash` when exact byte-level output or a truly empty file is required.

These behaviors intentionally match Codex `apply_patch`.

The provider contract is runtime-specific: use Pi 0.99.1 or newer for model-only tool exposure and the loadout hook; the metadata contract and development/integration tests use Pi 1.1.0.

For a manual smoke test:

1. Start Pi with this extension, the normal file tools, `codemode`, and a model that advertises `supportsOpenAIGrammarTools`.
2. Ask it to create and update a disposable file through a symlinked directory (on macOS, `/tmp` is suitable). Verify raw `apply_patch` calls, changed referent content, and an intact symlink.
3. Verify that `describeTool("edit")` and `describeTool("write")` work inside codemode and that scripts can edit a disposable file. `apply_patch` must not be callable inside codemode.
4. Run `/reload` and repeat the nested-editing check.
5. Switch to an unsupported model and verify that the selected native file tools remain usable. With codemode in `on` mode, their direct declarations return.

Automated contract tests cover provider declarations, codemode's `on` and `only` modes, reloads, exclusions, and approval wrappers registered in either extension load order.

## Development

```bash
npm run -w packages/pi-codex-tools check
npm test -w packages/pi-codex-tools
npm run -w packages/pi-codex-tools pack:dry-run
```

Install/update telemetry is disabled in CI and can be disabled with `PI_OFFLINE=1`, `PI_TELEMETRY=0` or `PI_TELEMETRY=false`, or Pi's `enableInstallTelemetry: false` setting. See [SECURITY.md](./SECURITY.md).

## License

This package is Apache-2.0 licensed because its grammar/parser behavior is adapted from OpenAI Codex. See [NOTICE](./NOTICE).
