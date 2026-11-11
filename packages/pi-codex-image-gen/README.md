# pi-codex-image-gen

Create and edit images without leaving [Pi](https://pi.dev).

`pi-codex-image-gen` turns natural-language requests and reference images into PNG, JPEG, or WebP assets through **ChatGPT subscription image generation**. Sign in from Pi; no Codex app or separate API key is required.

## Features

- **Generate images in conversation** — describe the asset you need and let Pi create it.
- **Edit from references** — transform up to five local or recent conversation images.
- **Create native cutouts** — request transparent backgrounds and preserve alpha during edits, without API billing or chroma keying.
- **Save where work happens** — return images inline or organize them by project, session, or custom directory.
- **Separate image login** — keep Pi chat on `openai` OAuth while the extension handles image authentication.
- **Scripted workflows without image payloads** — generate recoverable originals through codemode and load images only for explicit display.

## Recovery and parallel requests

`codex_list_image_artifacts({offset?, limit?, revision?})` returns metadata from
the same validated current-branch records as `/image-artifacts`, never bytes
or arbitrary manifests. It does not generate an image or consume image quota.
Pages default to 8 records (maximum 20) and 50,000 bytes. Continue with returned
`nextOffset` and `revision`; restart at offset zero if records change.
Each item includes `artifact`, `toolCallId` and `availability` (`present`,
`missing`, `unavailable`). Availability is a filesystem snapshot, not proof of
original contents or permission to read another branch.

```js
// Recover a generation completed before a later script error; do not regenerate.
const r = await tools.codex_list_image_artifacts({});
text(r.artifacts.map(x => ({ path: x.artifact.path, availability: x.availability })));
```

Artifact results additionally return `generationDurationMs`, `routingProvider`,
`routingModel`, optional `responseId`, `imageGenerationId`, and `reportedImage`.
The latter is an allowlisted, bounded backend report, not measured dimensions,
transparency, or proof of the served model. Inspect pixels separately.

Results keep `requestedImage`, `reportedImage`, and `measuredImage` separate.
`measuredImage` contains decoded width, height, output format, `alphaMin`,
`alphaMax`, and `hasTransparency`. Measurement is best-effort: it admits at most
16,777,216 header-declared pixels to an isolated decoder worker, with a three-second
inspection deadline. Originals are saved before inspection. If decoding fails,
exceeds a limit, or is cancelled, `measuredImage` is omitted and `imageWarning`
reports that pixels are unverified. This is not a full image-security audit.
Visual inspection is still required for edge quality and content.

If Codex returns a different supported format, the original is retained without
conversion, using its actual MIME type and filename extension. `imageWarning`
reports the mismatch; it never triggers regeneration. Bounded `requestId` and
`imagegenRequestId` values are returned when available.

Direct and artifact generation share account-local admission: two active
operations, eight queued operations, and at most 32 account scopes per process
module. The five-minute total deadline includes admission wait; network work
also keeps its existing deadline. Queueing is not authorization to generate
extra assets. Approved arguments are snapshotted before waits. Storage is
reserved after admission and before generation, not for every queued call.
Cancellation/reload releases queued work; completed originals are retained.
Cancellation after dispatch can still consume quota. There is no prompt-based
deduplication or new automatic retry policy.

Backend counters remain informational in `details.usage`, not Pi ledger
entries, verified charges or subscription-quota measurements. Unknown costs are
unknown, not zero. Goal token budgets do not enforce image quota. Image ledger
mapping is explicitly deferred until a reliable provider contract is approved.

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

The tool reports generation stages and the backend's returned size, quality, background, and format in `details.reportedImage`. These are server-reported values, not guarantees inferred from the prompt. `details.measuredImage`, when available, describes independently decoded pixels. `details.byteCount` records decoded bytes; `details.generationDurationMs` records elapsed generation/save/inspection time.

### Native transparency

Both tools accept `background: "transparent"`, `"opaque"`, or `"auto"`.
Omitting the parameter preserves the existing Responses request behavior.

```js
const result = await tools.codex_generate_image_artifact({
  prompt: "Isolate this product; preserve its shape, fine edges, and label text.",
  referencedImagePaths: ["product.png"],
  background: "transparent",
  outputFormat: "png",
  save: "project"
});
text(result);
```

Transparent output requires PNG or WebP; JPEG combinations reject before
authentication or generation. Preserve existing transparency during edits
unless an opaque background is requested. Use native alpha first, not a
chroma-key source or a separately billed API fallback. Check measured alpha and
inspect the image: a valid alpha channel alone does not guarantee a good cutout.

### Optional dedicated Images transport

Responses remains the default and supports PNG, JPEG, and WebP. Select
`transport: "images"` per call or in trusted configuration to use the Codex
subscription's dedicated `/images/generations` and `/images/edits` routes.
References select the edit route automatically. This is **not** the public
Images API and does not use API keys.

The opt-in transport is PNG-only. It follows Codex's client contract:
`gpt-image-2`, `quality: "auto"`, and `size: "auto"`. The identifier is not proof
of which model weights are served. Explicit routing `model` arguments and
JPEG/WebP output reject before generation; configured routing models apply
only to Responses. Per-call `transport` overrides configuration.
When `background` is omitted, new Images generation uses `opaque`, while
reference edits use `auto` rather than forcing opacity. Explicitly request
`transparent` when an edit must preserve alpha; automatic background selection
is not a guarantee.

There is no automatic transport fallback after any failure. This avoids
duplicate quota consumption and silent changes in output behavior. GIF, SVG,
complexity, masks, markup, exact size/quality controls, and Flare/Sunburst
selection are not exposed. In November 2026 tests, GIF requests were rejected
by both Pi and an official GIF-enabled Codex alpha. Client support alone does
not establish server access.

### Subscription reliability and limits

- Requests identify this package with a Pi User-Agent. The image login uses the Codex-compatible public OAuth client; it does not launch the Codex app, read its credentials, import browser cookies, or fall back to paid API calls.
- One five-minute network deadline covers the connection, retries, and stream. Escape cancels network work; the remote generation may still finish.
- Prompts: 32,000 characters. References: five regular PNG/JPEG/WebP files or conversation images, at most 20 MiB each and 50 MiB combined.
- Responses: 100 MiB total, with at most one 32 MiB decoded output image. Base64 and format signatures are checked; bounded worker inspection additionally measures supported images when possible. Backend text and revised prompts are limited to 4,000 characters; HTTP error bodies are read only up to 16 KiB and are not displayed.
- Transient HTTP failures have bounded retries. Quota exhaustion, moderation errors, failed/incomplete streams, connection errors, and deadlines are not automatically retried. Avoid immediately repeating an ambiguous failure: the first generation may have consumed quota.
- Local save settings are checked before generation. Existing files are never overwritten; a persistent save failure still returns the direct inline image or scripted original artifact and a bounded warning.
- Cloudflare challenges are reported as connection failures, not as proof that your subscription or image model is unsupported.

### Direct and codemode tools

Use Pi 1.5.2 and Node.js >=22.19.0.

| Tool | Reachability | Delivery |
| --- | --- | --- |
| `codex_generate_image` | Model-only; available directly with codemode off, `on`, or `only`. Nested calls are blocked. | Summary and inline image, plus an optional persistent save. |
| `codex_generate_image_artifact` | Codemode and other nested callers. Not declared directly by default, but explicit activation is supported. | Structured metadata and an original file path; no image payload. |

Pi's `codemode` exposure is not a strict codemode-only restriction. Other tools
can call the artifact tool through `ctx.executeTool()`. If explicitly activated
directly, it still returns paths and metadata rather than an image attachment.
Both tools use the same generation/editing parameters, image login, backend,
validation, and quota safeguards.

Both definitions share the `codex_images` namespace and advisory hints:
mutating, non-destructive (no overwrites), non-idempotent, and open-world.
Generation can consume quota and write files; these hints never grant approval.
Await `describeNamespace("codex_images")` or
`searchTools("image artifact", { namespace: "codex_images" })` for the callable
artifact tool, including with zero inline budget. The inline tool stays
model-only and receives no new output schema. The artifact schema, delivery,
recovery, explicit-request policy, and no-automatic-retry rules are unchanged.

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

### Native Pi image models

`codex-images` is an **authentication-only provider**, not an image-model
catalog entry. Pi's `models.generateImages()` and
`ctx.modelRegistry.generateImages()` do not expose this package's subscription
backend. Continue using the direct or artifact tool above. OpenRouter image
models use their own credentials/billing and are not a subscription fallback.

A native adapter remains deferred; the historical assessment used Pi 1.1.0. The generic image
context provides text/image blocks, not this package's save modes, routing
override, output-format control, or branch-aware recent-image selection.
Generic calls also do not inherit the image tools' approval hooks or exclusions.
Registering an image operation would add another callable surface, not merely
another discovery label.

Generic codemode image results are held in memory until explicitly displayed.
An undisplayed image has no automatically saved original or `/image-artifacts`
record. VM memory or aggregate output limits can reject display after
generation finishes. A successful `image()` display saves a temporary copy,
but that is not this package's pre-generation reservation and branch-recovery
contract. The artifact tool avoids transporting large originals as base64.

The current tools retain backend numeric counters in `details.usage`; these
are informational, not Pi ledger entries or verified subscription charges.
Pi aggregates **reported** native image usage on a codemode result, but a raw
extension `generateImages()` call does not automatically persist it. Neither
missing usage nor a zero catalog price proves generation is free. A future
adapter needs an explicit accounting and unknown-cost policy as well as safe
delivery, recovery, authentication, and approval contracts.

### Images 2.5 and API fallback

The optional `skills/imagegen/scripts/image_gen.py` API CLI accepts `--model gpt-image-2.5-flare` or `--model gpt-image-2.5-sunburst`, including their `2026-09-08` snapshots. Both accept `--quality xhigh` and `--quality max` in addition to the existing quality settings. The CLI default remains `gpt-image-2`. Both 2.5 models support `--size auto` and custom dimensions such as `1536x864`, under the [documented size constraints](skills/imagegen/references/image-api.md#flexible-sizes-gpt-image-2-and-25). Resolutions above `2560x1440` are experimental.

The existing CLI's native-transparency path uses `OPENAI_API_KEY` and separate API billing. It is not required for native transparency through the Pi subscription tools. This change does not expand API fallback capabilities.

Public API model selection does not establish support for the same options on the private Codex backend. The extension does not expose Flare/Sunburst selection or claim that your account has received the Images 2.5 rollout.

In subscription tests on September 11, 2026, the direct endpoint accepted Flare, Sunburst, and an invalid model name without reporting a served model. It also returned different size, quality, and background values than requested. The Responses route generated an image successfully. These account-specific results do not justify a guaranteed subscription model selector. See [the investigation and test procedure](CONTRIBUTING.md#subscription-capability-check).

## Authentication

| Credential / route | Model selection | Usage and fallback |
| --- | --- | --- |
| `codex-images` OAuth / private Codex Responses or Images | `model` selects a Responses routing model, not an image model; Images uses automatic server-selected rendering | ChatGPT image quota; preferred credential |
| Legacy Pi `openai-codex` OAuth / same backend | Same routing semantics | Used only when owned image credentials are absent; no switch after an auth/generation failure |
| Pi `openai` ChatGPT plan-sharing login | Any chat model | Not accepted for image generation; never sent to this backend |
| OpenAI API key | Explicit standalone Python CLI only | Separate API billing; never an automatic fallback from the Pi tool |

Changing the chat default to GPT-6.1 Sol does not change image authentication
or certify the image backend's served model. The backend chooses the image
model; successful inference on another route is not image capability evidence.

The extension owns an image-capable ChatGPT OAuth flow, registered as **Codex Images** (`codex-images`). Pi stores its credentials and handles refresh. Your chat provider can remain `openai`; image authentication is independent.

```
> /login codex-images
```

Complete the browser login with your ChatGPT account. You can also run `/login` and select **Codex Images (ChatGPT subscription)**. The browser redirects to `http://localhost:1455/auth/callback`. If the callback cannot reach Pi, paste the **full redirect URL** into Pi's login prompt, not into chat. Login expires after ten minutes.

Use Pi 1.5.2. Pi stores the `codex-images` credential in its agent auth store (normally `~/.pi/agent/auth.json`). `/logout codex-images` removes that credential without changing your chat login. No credential files are created by the extension itself.

The package implements the Codex-compatible OAuth protocol itself. It neither imports Pi's `openai-codex` OAuth helpers nor requires the Codex app or its credential store. It still depends on OpenAI continuing to accept that public OAuth client and private image endpoint; this is not a new OAuth application registered with OpenAI.

Existing Pi `openai-codex` credentials remain a compatibility fallback when `codex-images` credentials are absent and the legacy provider is available. With both image logins, `codex-images` wins. A selected login that fails to refresh or generate does not switch to another account. Configured but unusable image credentials also block fallback, including a stored API-key credential that Pi's OAuth-only provider cannot resolve. Re-run `/login codex-images` to repair that login instead of silently using a different account.

Both image logins use fixed HTTPS routes under `https://chatgpt.com/backend-api/codex/`: Responses by default, or the dedicated Images routes when explicitly selected. Pi's new `openai` plan-sharing OAuth grant is different and [does not support image generation](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). The extension never sends that chat token to the Codex backend. API keys do **not** enable this tool or API-key billing.

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
| `model`   | string | see below  | Codex routing model, not the backend image model. |
| `transport` | string | `"responses"` | Subscription route: `responses` or opt-in PNG-only `images`. |

When neither the call nor configuration sets `model`, the routing model is `gpt-6-astra` while the running Pi lists it for the `openai-codex` provider. If a newer Pi catalog drops it, the extension uses the current session model when it is an `openai-codex` model, else the first `openai-codex` model Pi lists. If Pi lists no `openai-codex` models, `gpt-6-astra` is sent. Explicit and configured values are always sent unchanged.

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
| `model`        | string | —        | Override the Codex routing model. Defaults to config, then the catalog-aware default (normally `gpt-6-astra`). |
| `outputFormat` | string | —        | `png` (default), `jpeg`, or `webp`.                                |
| `background` | string | — | `transparent`, `opaque`, or `auto`; omission preserves existing Responses behavior. |
| `transport` | string | — | Override configured subscription transport: `responses` or PNG-only `images`. |
| `save`         | string | —        | Override save mode for this call.                                  |
| `saveDir`      | string | —        | Directory when `save=custom`. Relative paths resolve under CWD.    |
| `referencedImagePaths` | string[] | — | Up to five local images to edit. Relative paths resolve under CWD. |
| `numLastImagesToInclude` | integer | — | Include the most recent one to five conversation images for editing. Mutually exclusive with `referencedImagePaths`. |

## How it works

1. Resolves package-owned `codex-images` OAuth via Pi, or falls back to available legacy Pi `openai-codex` OAuth.
2. Sends a request through Responses and its routing model (default `gpt-6-astra` while Pi's `openai-codex` catalog lists it), or the explicitly selected PNG-only Images transport.
3. For edits, attaches the selected local or conversation images to the request.
4. The backend selects an image model to generate or edit the image.
5. Parses bounded SSE or Images JSON and validates base64 and the actual returned file format.
6. For the artifact tool, commits the reserved temporary original and records its branch-local recovery metadata.
7. Saves a persistent copy according to the active save mode; failures produce a bounded warning without discarding a usable inline image or artifact.
8. Attempts bounded, isolated pixel inspection, then returns the direct inline image or structured artifact metadata. Codemode displays an image only through an explicit `read` and `image()` operation.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Missing image OAuth credentials" | No image-capable subscription login; chat OAuth and API keys are not sufficient | Run `/login codex-images` |
| 401 / 403 response | Image login rejected or token expired | Re-run `/login codex-images` |
| 429 response | Rate limited | Wait and retry; the extension retries automatically with backoff |
| "Codex did not return an image" | Backend refused the prompt | Rephrase the prompt and try again |
| "save=custom requires saveDir" | Missing config | Set `saveDir` in config or `PI_CODEX_IMAGE_SAVE_DIR` env var |
| Unsupported-feature error | Backend feature gate or unsupported parameter | Check the supported subscription controls; do not switch transports or billing automatically |
| `imageWarning` | Format mismatch, unavailable inspection, or inconsistent properties | Keep the completed original and inspect it locally; do not regenerate automatically |

## License

Apache-2.0. See [LICENSE](./LICENSE).

This package includes imagegen skill helper files derived from [OpenAI Codex](https://github.com/openai/codex), including `skills/imagegen/scripts/image_gen.py`. Those files remain under the Apache License, Version 2.0. See [NOTICE](./NOTICE) and `skills/imagegen/LICENSE.txt`.
