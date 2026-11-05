---
name: "imagegen"
description: "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when Codex should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

# Image Generation Skill

> Adapted from OpenAI Codex's `imagegen` skill for Pi.
> Original source: https://github.com/openai/codex/tree/main/codex-rs/skills/src/assets/samples/imagegen
> Subscription guidance reconciled with Codex `rust-v0.168.0-alpha.3`, including the model-facing image-tool instructions.
> Required Pi modifications: use Pi's `codex_generate_image` tool name, Pi artifact paths, and the bundled helper path.

Generates or edits images for the current project (for example website assets, game assets, UI mockups, product mockups, wireframes, logo design, photorealistic images, or infographics).

## Top-level modes and rules

This skill has exactly two top-level modes:

- **Default Pi tool mode (preferred):** Pi `codex_generate_image` tool for new image generation, edits using up to five local or recent conversation images, reference variants, and native transparent-image requests. Does not require `OPENAI_API_KEY`.
- **Fallback CLI mode:** `scripts/image_gen.py` CLI. Use only when the user explicitly asks for or confirms the CLI/API/model path. Requires `OPENAI_API_KEY` and separate API billing.

Within CLI fallback, the CLI exposes three subcommands:

- `generate`
- `edit`
- `generate-batch`

Rules:
- Recover existing current-branch artifacts with `tools.codex_list_image_artifacts({})` after a later script failure; inspect availability and use returned paths instead of generating again. Listing consumes no image quota. Continue paginated listings with revision/nextOffset.
- Direct and artifact requests share bounded account admission (two active, eight queued). Queue time counts toward the five-minute total deadline. Queueing does not authorize extra assets; cancellation after dispatch can still consume quota. Reported metadata is not measured pixel properties or verified cost.
- Use the Pi `codex_generate_image` tool by default for new image generation requests.
- `codex_generate_image` is model-only; call it directly, never through codemode. For scripted workflows use `tools.codex_generate_image_artifact(...)`, which returns `{ summary, artifact: { path, mimeType, byteCount }, savedPath?, saveWarning? }` without image bytes. Both tools support the same generation/edit parameters and subscription login. Use Pi 1.4.0 or later.
- To display an artifact, call `tools.read({path: result.artifact.path})`, then `image(block)` if the returned value is an image block. Pi can resize or omit an un-decodable display image; the original remains unchanged. Never print or store base64 image bytes. Pass artifact paths directly through `referencedImagePaths` for chained edits.
- Artifact `save: "none"` still writes a private temporary original; it means no persistent user copy. Completed originals survive script failure/timeout, reload, shutdown, and branch changes until user/OS cleanup. Copy needed project assets to persistent storage. Run `/image-artifacts` to recover current-branch paths without generation. Recent-image selection includes branch-local original artifacts, even if never displayed; reference-size limits still apply.
- Do not retry artifact-storage failures automatically. Known storage failures reject before generation; failures after backend success can already have consumed quota. A successful requested persistent save can be used as recovery if the temporary write fails. If neither succeeds, the tool explicitly reports that no artifact is recoverable.
- Image login is separate from chat: use `/login codex-images` and complete the ChatGPT OAuth flow in Pi. The Codex app is not required. Existing legacy Pi `openai-codex` OAuth can be a fallback; new `openai` plan-sharing chat OAuth cannot generate images. Never ask the user to paste login URLs or tokens into chat.
- Legacy OAuth is used only when owned image credentials are absent. Configured but unusable `codex-images` credentials block fallback; repair that login instead of switching accounts.
- `codex-images` has no native Pi image-model entry. Do not substitute `models.generateImages()` or an OpenRouter image model for these subscription tools: native image calls do not inherit their approval, save/recovery, output-size, or billing contracts.
- The tool's `model` parameter selects a Codex routing model, not Flare or Sunburst. Do not claim a specific served image model unless the response reports it. Read `details.reportedImage` for backend-reported output settings, then inspect the actual image; prompt requests for quality, dimensions, or transparency are not guarantees.
- The default routing model is `gpt-6-astra`. Explicit tool parameters and configuration values override this default.
- Keep the default `responses` transport unless the user explicitly selects `images` or trusted configuration selects it. `images` is PNG-only, uses automatic size/quality, and rejects a per-call routing `model`. Never switch transports automatically after a failure.
- `requestedImage` is intent, `reportedImage` is the server report, and `measuredImage` contains independently decoded dimensions and alpha properties. `imageWarning` does not authorize regeneration. Preserve originals if inspection is unavailable or a format differs.
- Do not request GIF, SVG, complexity, masks, markup, or Flare/Sunburst selection through these subscription tools. GIF client support exists upstream but server access is not verified for this extension.
- Do not automatically repeat quota, connection, timeout, or incomplete-stream failures. The remote generation may already have consumed quota.
- Use `referencedImagePaths` for edits when every target has a local path. Inspect unseen local targets with Pi `read` first. Use `numLastImagesToInclude` only when a target is available solely in recent conversation history. Never provide both selectors. Masks and advanced CLI-only controls still require confirmed CLI fallback.
- Do not switch to CLI fallback for ordinary generation quality, size, or output file-path control.
- For cutouts or background removal, set `background: "transparent"` and use PNG or WebP. For edits, preserve existing transparency unless the user asks to change it.
- Never silently switch from Pi `codex_generate_image` or CLI `gpt-image-2` to CLI `gpt-image-1.5`. Treat this as a model/path downgrade and ask the user before doing it, unless the user has already explicitly requested `gpt-image-1.5`, `scripts/image_gen.py`, or CLI fallback.
- The word `batch` by itself does not mean CLI fallback. If the user asks for many assets or says to batch-generate assets without explicitly asking for CLI/API/model controls, stay on the Pi tool path and issue one Pi tool call per requested asset or variant.
- If the Pi tool fails or is unavailable, tell the user the CLI fallback exists and that it requires `OPENAI_API_KEY`. Proceed only if the user explicitly asks for that fallback.
- If the user explicitly asks for CLI mode, use the bundled `scripts/image_gen.py` workflow. Do not create one-off SDK runners.
- Never modify `scripts/image_gen.py`. If something is missing, ask the user before doing anything else.

Pi tool save-path policy:
- In Pi tool mode, generated images are saved under Pi's agent directory by default: `<pi-agent-dir>/generated-images/<pi-session-id>/<image-call-id>.*`. The default Pi agent directory is `~/.pi/agent`, but it can be overridden with `PI_CODING_AGENT_DIR`; use Pi's configured agent directory, not a hardcoded home path.
- Do not describe OS temp as the default persistent destination. The artifact tool additionally keeps a private temporary original regardless of persistent save mode; its path is not a durable project asset.
- Use the tool's `save` and `saveDir` controls to choose a save directory. Custom mode appends a session directory; it does not accept an exact output filename. If an exact asset path is needed, copy the generated image there and leave the original in place.
- Save-path precedence in Pi tool mode:
  1. If the user names a destination, copy the selected output there and leave the original in place.
  2. If the image is meant for the current project, copy the final selected image into the workspace before finishing and leave the original in place.
  3. If the image is only for preview or brainstorming, render it inline; the underlying file can remain at the default `<pi-agent-dir>/generated-images/<pi-session-id>/*` path.
- Never leave a project-referenced asset only at the default `<pi-agent-dir>/generated-images/<pi-session-id>/*` path.
- Move or delete a Pi-generated original only when the user explicitly requests it.
- Use a matching extension when copying returned bytes to a project filename. If the requested filename's extension differs from the actual format, report the mismatch and use the actual extension. Do not simply rename JPEG bytes to `.png` or otherwise disguise the format; an exact-format conversion must be a separate, explicit local operation that preserves the original.
- Do not overwrite an existing asset unless the user explicitly asked for replacement; otherwise create a sibling versioned filename such as `hero-v2.png` or `item-icon-edited.png`.

Shared prompt guidance for both modes lives in `references/prompting.md` and `references/sample-prompts.md`.

Fallback-only docs/resources for CLI mode:
- `references/cli.md`
- `references/image-api.md`
- `references/codex-network.md`
- `scripts/image_gen.py`

Local post-processing helper:
- `scripts/remove_chroma_key.py`: optional local recovery for an existing chroma-key source. It is not the normal transparency workflow.

## When to use
- Generate a new image (concept art, product shot, cover, website hero)
- Generate a new image using one or more reference images for style, composition, or mood
- Edit an existing image (inpainting, lighting or weather transformations, background replacement, object removal, compositing, transparent background)
- Produce many assets or variants for one task

## When not to use
- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo
- Creating simple shapes, diagrams, wireframes, or icons that are better produced directly in SVG, HTML/CSS, or canvas
- Making a small project-local asset edit when the source file already exists in an editable native format
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap

## Decision tree

Think about two separate questions:

1. **Intent:** is this a new image or an edit of an existing image?
2. **Execution strategy:** is this one asset or many assets/variants?

Intent:
- If the user wants to modify an existing image while preserving parts of it, treat the request as **edit**.
- If the user provides images only as references for style, composition, mood, or subject guidance, treat the request as **generate**.
- If the user provides no images, treat the request as **generate**.

Pi edit semantics:
- Inspect unseen local targets with Pi `read` before editing, while passing original file paths to the generation tool.
- Use `referencedImagePaths` when all edit targets have readable local paths, with at most five paths.
- Use `numLastImagesToInclude` for the smallest recent-conversation window containing all targets, from one to five images.
- Never provide both image selectors. If neither can include every target, ask the user to attach or provide the missing image.
- Use confirmed CLI fallback only for masks or other explicit CLI-only parameters.
- For edits, preserve invariants aggressively and save non-destructively by default.
- Preserve existing alpha with `background: "transparent"` unless the user requests an opaque background.

Execution strategy:
- In the Pi tool default path, produce many assets or variants by issuing one `codex_generate_image` call per requested asset or variant.
- In the CLI fallback path, use the CLI `generate-batch` subcommand only when the user explicitly chose CLI mode and needs many prompts/assets.
- For many distinct assets, do not use `n` as a substitute for separate prompts. `n` is for variants of one prompt; distinct assets need distinct Pi tool calls or distinct CLI `generate-batch` jobs.

Assume the user wants a new image unless they clearly ask to change an existing one.

## Workflow
1. Decide the top-level mode: Pi tool by default, including native transparent-output requests; fallback CLI only if explicitly requested or confirmed.
2. Decide the intent: `generate` or `edit`.
3. Decide whether the output is preview-only or meant to be consumed by the current project.
4. Decide the execution strategy: single asset vs repeated Pi tool calls vs CLI `generate-batch`.
5. Collect inputs up front: prompt(s), exact text (verbatim), constraints/avoid list, and any input images.
6. For every input image, label its role explicitly:
   - reference image
   - edit target
   - supporting insert/style/compositing input
7. Inspect unseen local targets with Pi `read`, then pass up to five original paths through `referencedImagePaths`. For pathless conversation images, use the smallest valid `numLastImagesToInclude`.
8. If the user asked for a photo, illustration, sprite, product image, banner, or other explicitly raster-style asset, use `codex_generate_image` rather than substituting SVG/HTML/CSS placeholders. If the request is for an icon, logo, or UI graphic that should match existing repo-native SVG/vector/code assets, prefer editing those directly instead.
9. Augment the prompt based on specificity:
   - If the user's prompt is already specific and detailed, normalize it into a clear spec without adding creative requirements.
   - If the user's prompt is generic, add tasteful augmentation only when it materially improves output quality.
10. Use the Pi `codex_generate_image` tool by default for generation and supported existing-image edits. Ask for CLI fallback confirmation only when the request requires unsupported controls such as masks.
11. For transparent-output requests, set `background: "transparent"` and preserve the returned alpha. For edits, preserve existing transparency unless asked to change it.
12. Inspect outputs and validate: subject, style, composition, text accuracy, and invariants/avoid items.
13. Iterate with a single targeted change, then re-check.
14. For preview-only work, render the image inline; the underlying file may remain at the default `<pi-agent-dir>/generated-images/<pi-session-id>/<image-call-id>.*` path.
15. For project-bound work, copy the selected artifact into the workspace, leave the original in place, and update any consuming code or references. Never leave a project-referenced asset only at the default `<pi-agent-dir>/generated-images/<pi-session-id>/<image-call-id>.*` path.
16. For batches or multi-asset requests, persist every requested deliverable final in the workspace unless the user explicitly asked to keep outputs preview-only. Discarded variants do not need to be kept unless requested.
17. If the user explicitly chooses or confirms the CLI fallback, then use the fallback-only docs for model, quality, size, `input_fidelity`, masks, output format, output paths, and network setup.
18. Always report the final saved path(s) for any workspace-bound asset(s), plus the final prompt or prompt set and whether the Pi tool or fallback CLI mode was used.

## Transparent image requests

Use Pi's native `background: "transparent"` control, including for hair, glass,
soft shadows, and other subjects that chroma keying handles poorly. Use PNG or
WebP with Responses; the opt-in Images transport supports PNG only.

Preserve the original bytes and alpha. Check `measuredImage.hasTransparency`
when available and inspect the visual result for edge quality, subject coverage,
and unwanted background. If inspection is unavailable, report that uncertainty;
do not automatically regenerate or switch to paid API billing.

For transparent-image edits, repeat the invariants and preserve existing alpha
unless the user requests a different background. Do not add key colors or ban
shadows and reflections merely to simplify background removal. Keep project
assets in persistent workspace storage, leaving private originals intact.

## Prompt augmentation

Reformat user prompts into a structured, production-oriented spec. Make the user's goal clearer and more actionable, but do not blindly add detail.

Treat this as prompt-shaping guidance, not a closed schema. Use only the lines that help, and add a short extra labeled line when it materially improves clarity.

### Specificity policy

Use the user's prompt specificity to decide how much augmentation is appropriate:

- If the prompt is already specific and detailed, preserve that specificity and only normalize/structure it.
- If the prompt is generic, you may add tasteful augmentation when it will materially improve the result.

Allowed augmentations:
- composition or framing hints
- polish level or intended-use hints
- practical layout guidance
- reasonable scene concreteness that supports the stated request

Not allowed augmentations:
- extra characters or objects that are not implied by the request
- brand names, slogans, palettes, or narrative beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Use-case taxonomy (exact slugs)

Classify each request into one of these buckets and keep the slug consistent across prompts and references.

Generate:
- photorealistic-natural — candid/editorial lifestyle scenes with real texture and natural lighting.
- product-mockup — product/packaging shots, catalog imagery, merch concepts.
- ui-mockup — app/web interface mockups and wireframes; specify the desired fidelity.
- infographic-diagram — diagrams/infographics with structured layout and text.
- scientific-educational — classroom explainers, scientific diagrams, and learning visuals with required labels and accuracy constraints.
- ads-marketing — campaign concepts and ad creatives with audience, brand position, scene, and exact tagline/copy.
- productivity-visual — slide, chart, workflow, and data-heavy business visuals.
- logo-brand — logo/mark exploration, vector-friendly.
- illustration-story — comics, children’s book art, narrative scenes.
- stylized-concept — style-driven concept art, 3D/stylized renders.
- historical-scene — period-accurate/world-knowledge scenes.

Edit:
- text-localization — translate/replace in-image text, preserve layout.
- identity-preserve — try-on, person-in-scene; lock face/body/pose.
- precise-object-edit — remove/replace a specific element (including interior swaps).
- lighting-weather — time-of-day/season/atmosphere changes only.
- background-extraction — transparent background / clean cutout. Set `background: "transparent"` and preserve fine edges, label text, and alpha.
- style-transfer — apply reference style while changing subject/scene.
- compositing — multi-image insert/merge with matched lighting/perspective.
- sketch-to-render — drawing/line art to photoreal render.

## Shared prompt schema

Use the following labeled spec as shared prompt scaffolding for both top-level modes:

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Notes:
- `Asset type` and `Input images` are prompt scaffolding, not dedicated CLI flags.
- `Scene/backdrop` refers to the visual setting. It is not the same as the fallback CLI `background` parameter, which controls output transparency behavior.
- Quality, input fidelity, and masks are not Pi subscription parameters. Use Pi's actual camelCase `outputFormat`, `save`, `saveDir`, `background`, and `transport` controls, not CLI flag names.

Augmentation rules:
- Keep it short.
- Add only the details needed to improve the prompt materially.
- For edits, explicitly list invariants (`change only X; keep Y unchanged`).
- If any critical detail is missing and blocks success, ask a question; otherwise proceed.

## Examples

### Generation example (hero image)
```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy if needed
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

### Edit example (invariants)
```text
Use case: precise-object-edit
Asset type: product photo background replacement
Primary request: replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product and its edges unchanged; no text; no watermark
```

## Prompting best practices
- Structure prompt as scene/backdrop -> subject -> details -> constraints.
- Include intended use (ad, UI mock, infographic) to set the mode and polish level.
- Use camera/composition language for photorealism.
- Only use SVG/vector stand-ins when the user explicitly asked for vector output or a non-image placeholder.
- Quote exact text and specify typography + placement.
- For tricky words, spell them letter-by-letter and require verbatim rendering.
- For multi-image inputs, reference images by index and describe how they should be used.
- For edits, repeat invariants every iteration to reduce drift.
- Iterate with single-change follow-ups.
- If the prompt is generic, add only the extra detail that will materially help.
- If the prompt is already detailed, normalize it instead of expanding it.
- For CLI fallback only, see `references/cli.md` and `references/image-api.md` for model, `quality`, `input_fidelity`, masks, output format, and output-path guidance.
- For transparent images, request native transparency and preserve alpha. Do not switch billing merely for a cutout.

More principles shared by both modes: `references/prompting.md`.
Copy/paste specs shared by both modes: `references/sample-prompts.md`.

## Guidance by asset type
Asset-type templates (website assets, game assets, wireframes, logo) are consolidated in `references/sample-prompts.md`.

## gpt-image-2 guidance for CLI fallback

The fallback CLI defaults to `gpt-image-2`.

- Keep `gpt-image-2` as the CLI default. For explicit 2.5 requests, use `gpt-image-2.5-flare` for fast generation or `gpt-image-2.5-sunburst` for editing precision. Both also accept `xhigh` and `max` quality and their `2026-09-08` snapshots. Both support the flexible size constraints below; sizes above `2560x1440` are experimental. Leave 2.5 `input_fidelity` unset; support for that control is not verified.
- Native transparency is available in preview with CLI `gpt-image-2 --background transparent --output-format png` (or `webp`). Ask before switching from Pi to this separately billed API path.
- `gpt-image-2` always uses high fidelity for image inputs; do not set `input_fidelity` with this model.
- `gpt-image-2` supports `quality` values `low`, `medium`, `high`, and `auto`.
- Use `quality low` for fast drafts, thumbnails, and quick iterations. Use `medium`, `high`, or `auto` for final assets, dense text, diagrams, identity-sensitive edits, or high-resolution outputs.
- Square images are typically fastest to generate. Use `1024x1024` for fast square drafts.
- If the user asks for 4K-style output, use `3840x2160` for landscape or `2160x3840` for portrait.
- GPT Image 2 and 2.5 API size may be `auto` or `WIDTHxHEIGHT` if all constraints hold: max edge `<= 3840px`, both edges multiples of `16px`, long-to-short ratio `<= 3:1`, total pixels between `655,360` and `8,294,400`.

Popular `gpt-image-2` sizes:
- `1024x1024` square
- `1536x1024` landscape
- `1024x1536` portrait
- `2048x2048` 2K square
- `2048x1152` 2K landscape
- `3840x2160` 4K landscape
- `2160x3840` 4K portrait
- `auto`

## Fallback CLI mode only

### Temp and output conventions
These conventions apply only to the CLI fallback. They do not describe Pi `codex_generate_image` output behavior.
- Use `tmp/imagegen/` for intermediate files (for example JSONL batches); delete them when done.
- Write final artifacts under `output/imagegen/`.
- Use `--out` or `--out-dir` to control output paths; keep filenames stable and descriptive.

### Dependencies
Prefer `uv` for dependency management in this repo.

Required Python package:
```bash
uv pip install openai
```

Optional for local inspection, chroma-key recovery, and downscaling:
```bash
uv pip install pillow
```

Portability note:
- If you are using the installed skill outside this repo, install dependencies into that environment with its package manager.
- In uv-managed environments, `uv pip install ...` remains the preferred path.

### Environment
- `OPENAI_API_KEY` must be set for live API calls.
- Do not ask the user for `OPENAI_API_KEY` when using the Pi `codex_generate_image` tool.
- Never ask the user to paste the full key in chat. Ask them to set it locally and confirm when ready.

If the key is missing, give the user these steps:
1. Create an API key in the OpenAI platform UI: https://platform.openai.com/api-keys
2. Set `OPENAI_API_KEY` as an environment variable in their system.
3. Offer to guide them through setting the environment variable for their OS/shell if needed.

If installation is not possible in this environment, tell the user which dependency is missing and how to install it into their active environment.

### Script-mode notes
- CLI commands + examples: `references/cli.md`
- API parameter quick reference: `references/image-api.md`
- Network approvals / sandbox settings for CLI mode: `references/codex-network.md`

## Reference map
- `references/prompting.md`: shared prompting principles for both modes.
- `references/sample-prompts.md`: shared copy/paste prompt recipes for both modes.
- `references/cli.md`: fallback-only CLI usage via `scripts/image_gen.py`.
- `references/image-api.md`: fallback-only API/CLI parameter reference.
- `references/codex-network.md`: fallback-only network/sandbox troubleshooting for CLI mode.
- `scripts/image_gen.py`: fallback-only CLI implementation. Do not load or use it unless the user explicitly chooses or confirms CLI mode.
- `scripts/remove_chroma_key.py`: local post-processing helper for Pi-tool transparent-image requests.
