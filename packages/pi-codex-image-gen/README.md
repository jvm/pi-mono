# pi-codex-image-gen

Create and edit images without leaving [Pi](https://pi.dev).

`pi-codex-image-gen` turns natural-language requests and reference images into PNG, JPEG, or WebP assets through **ChatGPT subscription image generation**. Sign in from Pi; no Codex app or separate API key is required.

## Features

- **Generate images in conversation** — describe the asset you need and let Pi create it.
- **Edit from references** — transform up to five local or recent conversation images.
- **Save where work happens** — return images inline or organize them by project, session, or custom directory.
- **Separate image login** — keep Pi chat on `openai` OAuth while the extension handles image authentication.
- **Scripted workflows without image payloads** — generate recoverable originals through codemode and load images only for explicit display.

## Install

```sh
pi install npm:pi-codex-image-gen
```

During local development from this monorepo:

```sh
pi install /path/to/pi-mono/packages/pi-codex-image-gen
```

For a one-off test run without installing:

```sh
pi -e /path/to/pi-mono/packages/pi-codex-image-gen
```

To uninstall:

```sh
pi remove npm:pi-codex-image-gen
```

## Quick usage

In a Pi session:

```
> Generate a pixel-art sword icon, 32×32, with a blue blade and gold hilt
```

The agent will invoke `codex_generate_image` with your prompt, optionally include up to five local or recent conversation images for editing, stream the response from the Codex backend, and save the resulting image to disk. The `model` parameter controls the Codex routing model, not the image model. The backend selects the image model; `backendImageModel` is `"unknown"` unless the response explicitly reports an image model.

The tool reports generation stages and the backend's returned size, quality, background, and format in `details.reportedImage`. These are server-reported values, not guarantees inferred from the prompt. `details.byteCount` records decoded bytes; `details.generationDurationMs` records elapsed generation/save time. Check the actual image before using it, especially for exact dimensions or alpha transparency.

### Subscription reliability and limits

- Requests identify this package with a Pi User-Agent. The image login uses the Codex-compatible public OAuth client; it does not launch the Codex app, read its credentials, import browser cookies, or fall back to paid API calls.
- One five-minute network deadline covers the connection, retries, and stream. Escape cancels network work; the remote generation may still finish.
- Prompts: 32,000 characters. References: five regular PNG/JPEG/WebP files or conversation images, at most 20 MiB each and 50 MiB combined.
- Responses: 100 MiB total, with at most one 32 MiB decoded output image. Base64 and format signatures are checked; this is not a full image decoder. Backend text and revised prompts are limited to 4,000 characters; HTTP error bodies are read only up to 16 KiB and are not displayed.
- Transient HTTP failures have bounded retries. Quota exhaustion, moderation errors, failed/incomplete streams, connection errors, and deadlines are not automatically retried. Avoid immediately repeating an ambiguous failure: the first generation may have consumed quota.
- Local save settings are checked before generation. Existing files are never overwritten; a persistent save failure still returns the direct inline image or scripted original artifact and a bounded warning.
- Cloudflare challenges are reported as connection failures, not as proof that your subscription or image model is unsupported.

### Direct and codemode tools

Use Pi 1.1.0 or newer and Node.js >=22.19.0.

| Tool | Reachability | Delivery |
| --- | --- | --- |
| `codex_generate_image` | Model-only; available directly with codemode off, `on`, or `only`. Nested calls are blocked. | Summary and inline image, plus an optional persistent save. |
| `codex_generate_image_artifact` | Codemode and other nested callers. Not declared directly by default, but explicit activation is supported. | Structured metadata and an original file path; no image payload. |

Pi's `codemode` exposure is not a strict codemode-only restriction. Other tools
can call the artifact tool through `ctx.executeTool()`. If explicitly activated
directly, it still returns paths and metadata rather than an image attachment.
Both tools use the same generation/editing parameters, image login, backend,
validation, and quota safeguards.

```js
const result = await tools.codex_generate_image_artifact({
  prompt: "A red fox in watercolor",
  save: "none"
});
text(result); // summary, artifact: {path, mimeType, byteCount}, savedPath?, saveWarning?
```

For explicit display:

```js
const preview = await tools.read({ path: result.artifact.path });
if (preview?.type === "image") image(preview);
else text(preview); // Pi can omit images it cannot decode or bound.
text(result.summary);
```

`read` can resize or omit an image that cannot be decoded within Pi's display
limits. Check that its result is an image block before calling `image()` when
handling untrusted outputs. The original file is unchanged. Do not print image
bytes using `text()`, `console`, or `return`, or store them in codemode's store.
Large originals (up to 32 MiB) are transported as paths, not base64 through
codemode's 16,777,216-character output budget. Pi's `image()` also saves a
temporary display copy.

For chained edits, use `referencedImagePaths: [result.artifact.path]`.
`numLastImagesToInclude` also reads artifact records from the current session
branch, including generations that were never displayed. The normal 20 MiB
per-reference and 50 MiB aggregate limits still apply: a 32 MiB output is
recoverable but cannot be used as an edit input without first reducing its size.
Each edit is a new generation request and can consume quota.

#### Artifact storage and recovery

The artifact tool reserves a new private `pi-codex-image-*` directory under the
OS temporary directory before generating. Original files have user-only
permissions (directory `0700`, file `0600`) and are never overwritten.
`save: "none"` means **no persistent user copy** for this tool; it does not
disable temporary original storage. The direct tool's `none` mode still does
not write the image to disk.

Completed originals are not automatically deleted by this extension, including
on script failure/timeout, reload, shutdown, or branch changes. They remain
until user or OS temporary-file cleanup; there is no guaranteed retention
period across OS cleanup or reboot. Copy needed assets to persistent storage.
Only incomplete reservations owned by the current call are cleaned up.

Before generation, a branch-local `codex-image-artifact-reservation` entry
anchors recovery to the originating branch. On completion, a private, bounded
JSON manifest beside the reserved original records path, MIME type, byte count,
and call ID. Normal same-branch completions also append a
`codex-image-artifact` session entry, without image bytes or prompts. Late
completions after cancellation do not append records to unrelated branches or
replacement sessions; the original branch's reservation reads the manifest.
Run `/image-artifacts` to list the last 20 recorded original paths on the
current branch without generation or network work. Records survive reload,
resume, and session forks that preserve the entries; abandoned branches are
not included. Listing reads validated recovery manifests, not image bytes, and
does not verify that an original still exists. A missing
original fails recent-image editing before generation; do not regenerate it
automatically.

If temporary storage is known to be unavailable, the artifact call fails before
generation. If writing the original fails after generation, a successful
requested persistent save becomes the recovery artifact, with a warning. If
neither file can be saved, the call fails explicitly: **quota may already have
been consumed and there is no recoverable artifact**. No generation retry is
made. A failure to persist session recovery metadata is reported with the
recoverable file path rather than hiding the completed file.

### Images 2.5 and API fallback

The optional `skills/imagegen/scripts/image_gen.py` API CLI accepts `--model gpt-image-2.5-flare` or `--model gpt-image-2.5-sunburst`, including their `2026-09-08` snapshots. Both accept `--quality xhigh` and `--quality max` in addition to the existing quality settings. The CLI default remains `gpt-image-2`. Both 2.5 models support `--size auto` and custom dimensions such as `1536x864`, under the [documented size constraints](skills/imagegen/references/image-api.md#flexible-sizes-gpt-image-2-and-25). Resolutions above `2560x1440` are experimental.

GPT Image 2 now supports native transparency in preview: use `--model gpt-image-2 --background transparent --output-format png` (or `webp`) in confirmed CLI mode. This uses `OPENAI_API_KEY` and separate API billing. The Pi tool still uses chroma-key removal because it has no background parameter.

Public API model selection does not establish support for the same options on the private Codex backend. The extension does not expose Flare/Sunburst selection or claim that your account has received the Images 2.5 rollout.

In subscription tests on September 11, 2026, the direct endpoint accepted Flare, Sunburst, and an invalid model name without reporting a served model. It also returned different size, quality, and background values than requested. The Responses route generated an image successfully. These account-specific results do not justify a guaranteed subscription model selector. See [the investigation and test procedure](CONTRIBUTING.md#subscription-capability-check).

## Authentication

The extension owns an image-capable ChatGPT OAuth flow, registered as **Codex Images** (`codex-images`). Pi stores its credentials and handles refresh. Your chat provider can remain `openai`; image authentication is independent.

```
> /login codex-images
```

Complete the browser login with your ChatGPT account. You can also run `/login` and select **Codex Images (ChatGPT subscription)**. The browser redirects to `http://localhost:1455/auth/callback`. If the callback cannot reach Pi, paste the **full redirect URL** into Pi's login prompt, not into chat. Login expires after ten minutes.

Use Pi 1.1.0 or later. Pi stores the `codex-images` credential in its agent auth store (normally `~/.pi/agent/auth.json`). `/logout codex-images` removes that credential without changing your chat login. No credential files are created by the extension itself.

The package implements the Codex-compatible OAuth protocol itself. It neither imports Pi's `openai-codex` OAuth helpers nor requires the Codex app or its credential store. It still depends on OpenAI continuing to accept that public OAuth client and private image endpoint; this is not a new OAuth application registered with OpenAI.

Existing Pi `openai-codex` credentials remain a compatibility fallback when `codex-images` credentials are absent and the legacy provider is available. With both image logins, `codex-images` wins. A selected login that fails to refresh or generate does not switch to another account.

Both image logins use `https://chatgpt.com/backend-api/codex/responses`. Pi's new `openai` plan-sharing OAuth grant is different and [does not support image generation](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). The extension never sends that chat token to the Codex backend. API keys do **not** enable this tool or API-key billing.

## Configuration

Create a JSON config file at one (or both) of these locations:

| Scope   | Path                                                    |
| ------- | ------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/codex-image-gen.json`           |
| Project | `<project-root>/.pi/extensions/codex-image-gen.json`    |

Project config overrides global config only when project trust is active. If project trust is declined or otherwise inactive, project config is ignored and global config still applies. Example:

```json
{
  "save": "global",
  "saveDir": "~/Pictures/generated",
  "model": "gpt-6-astra"
}
```

### Config keys

| Key       | Type   | Default    | Description                              |
| --------- | ------ | ---------- | ---------------------------------------- |
| `save`    | string | `"global"` | Default save mode (see below).           |
| `saveDir` | string | —          | Directory used when `save=custom`.       |
| `model`   | string | `"gpt-6-astra"`| Codex routing model, not the backend image model. |

### Environment variables

| Variable                     | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `PI_CODEX_IMAGE_SAVE_MODE`   | Overrides the `save` config key.                 |
| `PI_CODEX_IMAGE_SAVE_DIR`    | Overrides the `saveDir` config key (custom mode).|
| `PI_OFFLINE=1`               | Disables install/update telemetry.              |
| `PI_TELEMETRY=0`             | Disables install/update telemetry.              |

## Save modes

| Mode      | Behavior                                                         |
| --------- | ---------------------------------------------------------------- |
| `none`    | Direct tool: inline image, no disk save. Artifact tool: private temporary original, no persistent copy. |
| `project` | Saves to `<project>/.pi/generated-images/<session-id>/`.         |
| `global`  | Saves to `~/.pi/agent/generated-images/<session-id>/`.           |
| `custom`  | Saves to a user-specified directory (requires `saveDir` or env). `~` and `~/...` expand to the current user's home directory. |

## Tool parameters

Both generation entry points accept these parameters.

| Parameter      | Type   | Required | Description                                                        |
| -------------- | ------ | -------- | ------------------------------------------------------------------ |
| `prompt`       | string | ✅        | The image generation prompt.                                       |
| `model`        | string | —        | Override the Codex model. Defaults to config or `gpt-6-astra`.     |
| `outputFormat` | string | —        | `png` (default), `jpeg`, or `webp`.                                |
| `save`         | string | —        | Override save mode for this call.                                  |
| `saveDir`      | string | —        | Directory when `save=custom`. Relative paths resolve under CWD.    |
| `referencedImagePaths` | string[] | — | Up to five local images to edit. Relative paths resolve under CWD. |
| `numLastImagesToInclude` | integer | — | Include the most recent one to five conversation images for editing. Mutually exclusive with `referencedImagePaths`. |

## How it works

1. Resolves package-owned `codex-images` OAuth via Pi, or falls back to available legacy Pi `openai-codex` OAuth.
2. Sends a request to the Codex Responses endpoint and routing model (default `gpt-6-astra`) with the `image_generation` tool enabled.
3. For edits, attaches the selected local or conversation images to the request.
4. The backend selects an image model to generate or edit the image.
5. Parses the SSE stream and strictly validates the returned base64 and image format.
6. For the artifact tool, commits the reserved temporary original and records its branch-local recovery metadata.
7. Saves a persistent copy according to the active save mode; failures produce a bounded warning without discarding a usable inline image or artifact.
8. Returns the direct inline image or structured artifact metadata. Codemode displays an image only through an explicit `read` and `image()` operation.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Missing image OAuth credentials" | No image-capable subscription login; chat OAuth and API keys are not sufficient | Run `/login codex-images` |
| 401 / 403 response | Image login rejected or token expired | Re-run `/login codex-images` |
| 429 response | Rate limited | Wait and retry; the extension retries automatically with backoff |
| "Codex did not return an image" | Backend refused the prompt | Rephrase the prompt and try again |
| "save=custom requires saveDir" | Missing config | Set `saveDir` in config or `PI_CODEX_IMAGE_SAVE_DIR` env var |

## License

Apache-2.0. See [LICENSE](./LICENSE).

This package includes imagegen skill helper files derived from [OpenAI Codex](https://github.com/openai/codex), including `skills/imagegen/scripts/image_gen.py`. Those files remain under the Apache License, Version 2.0. See [NOTICE](./NOTICE) and `skills/imagegen/LICENSE.txt`.
