# pi-codex-image-gen

Create and edit images without leaving [Pi](https://pi.dev).

`pi-codex-image-gen` turns natural-language requests and reference images into PNG, JPEG, or WebP assets through **Codex image generation**, using your existing ChatGPT Codex login instead of a separate API key.

## Features

- **Generate images in conversation** — describe the asset you need and let Pi create it.
- **Edit from references** — transform up to five local or recent conversation images.
- **Save where work happens** — return images inline or organize them by project, session, or custom directory.
- **No separate API setup** — reuse your existing ChatGPT Plus/Pro Codex authentication.

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

- Requests identify this package with a Pi User-Agent. There is no Codex impersonation, browser-cookie import, or paid API fallback.
- One five-minute network deadline covers the connection, retries, and stream. Escape cancels network work; the remote generation may still finish.
- Prompts: 32,000 characters. References: five regular PNG/JPEG/WebP files or conversation images, at most 20 MiB each and 50 MiB combined.
- Responses: 100 MiB total, with at most one 32 MiB decoded output image. Base64 and format signatures are checked; this is not a full image decoder. Backend text and revised prompts are limited to 4,000 characters; HTTP error bodies are read only up to 16 KiB and are not displayed.
- Transient HTTP failures have bounded retries. Quota exhaustion, moderation errors, failed/incomplete streams, connection errors, and deadlines are not automatically retried. Avoid immediately repeating an ambiguous failure: the first generation may have consumed quota.
- Local save settings are checked before generation. Existing files are never overwritten; a save failure still returns the inline image and a warning.
- Cloudflare challenges are reported as connection failures, not as proof that your subscription or image model is unsupported.

### Images 2.5 and API fallback

The optional `skills/imagegen/scripts/image_gen.py` API CLI accepts `--model gpt-image-2.5-flare` or `--model gpt-image-2.5-sunburst`, including their `2026-09-08` snapshots. Both accept `--quality xhigh` and `--quality max` in addition to the existing quality settings. The CLI default remains `gpt-image-2`. For 2.5, use `--size auto` or the existing standard sizes; extended resolution rules are not yet verified.

GPT Image 2 now supports native transparency in preview: use `--model gpt-image-2 --background transparent --output-format png` (or `webp`) in confirmed CLI mode. This uses `OPENAI_API_KEY` and separate API billing. The Pi tool still uses chroma-key removal because it has no background parameter.

Public API model selection does not establish support for the same options on the private Codex backend. The extension does not expose Flare/Sunburst selection or claim that your account has received the Images 2.5 rollout.

## Authentication

Uses your existing **openai-codex** login — no `OPENAI_API_KEY` required. If you haven't logged in yet:

```
> /login
```

Select **ChatGPT Plus/Pro (Codex)** and complete the OAuth flow.

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
  "model": "gpt-5.5"
}
```

### Config keys

| Key       | Type   | Default    | Description                              |
| --------- | ------ | ---------- | ---------------------------------------- |
| `save`    | string | `"global"` | Default save mode (see below).           |
| `saveDir` | string | —          | Directory used when `save=custom`.       |
| `model`   | string | `"gpt-5.5"`| Codex routing model, not the backend image model. |

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
| `none`    | Image is returned inline but not written to disk.                |
| `project` | Saves to `<project>/.pi/generated-images/<session-id>/`.         |
| `global`  | Saves to `~/.pi/agent/generated-images/<session-id>/`.           |
| `custom`  | Saves to a user-specified directory (requires `saveDir` or env). `~` and `~/...` expand to the current user's home directory. |

## Tool parameters

| Parameter      | Type   | Required | Description                                                        |
| -------------- | ------ | -------- | ------------------------------------------------------------------ |
| `prompt`       | string | ✅        | The image generation prompt.                                       |
| `model`        | string | —        | Override the Codex model. Defaults to config or `gpt-5.5`.         |
| `outputFormat` | string | —        | `png` (default), `jpeg`, or `webp`.                                |
| `save`         | string | —        | Override save mode for this call.                                  |
| `saveDir`      | string | —        | Directory when `save=custom`. Relative paths resolve under CWD.    |
| `referencedImagePaths` | string[] | — | Up to five local images to edit. Relative paths resolve under CWD. |
| `numLastImagesToInclude` | integer | — | Include the most recent one to five conversation images for editing. Mutually exclusive with `referencedImagePaths`. |

## How it works

1. Resolves auth via Pi's `openai-codex` provider (ChatGPT session token).
2. Sends a Codex Responses API request to the routing model (default `gpt-5.5`) with the `image_generation` tool enabled.
3. For edits, attaches the selected local or conversation images to the request.
4. The backend selects an image model to generate or edit the image.
5. Parses the SSE stream and strictly validates the returned base64 and image format.
6. Saves the image according to the active save mode; persistence failures produce a warning without discarding a valid inline image.
7. Returns the image data inline plus metadata (model, format, path, revised prompt, usage).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Missing openai-codex credentials" | Not logged in | Run `/login` and select **ChatGPT Plus/Pro (Codex)** |
| 401 / 403 response | Token expired | Re-run `/login` for openai-codex |
| 429 response | Rate limited | Wait and retry; the extension retries automatically with backoff |
| "Codex did not return an image" | Backend refused the prompt | Rephrase the prompt and try again |
| "save=custom requires saveDir" | Missing config | Set `saveDir` in config or `PI_CODEX_IMAGE_SAVE_DIR` env var |

## License

Apache-2.0. See [LICENSE](./LICENSE).

This package includes imagegen skill helper files derived from [OpenAI Codex](https://github.com/openai/codex), including `skills/imagegen/scripts/image_gen.py`. Those files remain under the Apache License, Version 2.0. See [NOTICE](./NOTICE) and `skills/imagegen/LICENSE.txt`.
