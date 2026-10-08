# Contributing

Thanks for your interest in contributing to `pi-codex-image-gen`.

## Development setup

```bash
npm install
npm run check
```

The package is source-distributed: Pi loads the TypeScript extension file directly. There is no build step for runtime use.

## Local testing

Install this checkout into a temporary Pi project:

```bash
mkdir -p <test-project>
cd <test-project>
pi install -l /path/to/pi-mono/packages/pi-codex-image-gen
pi
```

With Pi 1.1.0 or later, run `/login codex-images`, complete the ChatGPT browser login, and ask Pi to generate an image. Chat can stay on `openai` OAuth. Neither the Codex app nor Pi's legacy OAuth helpers are required.

### Image delivery smoke test

The default tests use real Pi sessions with synthetic credentials and mocked SSE;
they do not consume subscription quota. Test both nested events and the parent
codemode result. The shared development baseline is Pi 1.1.0 on Node >=22.19.0.

For an explicitly authorized live smoke test, load this package in a disposable
Pi profile with the existing image-capable OAuth login. Keep credentials out of
the repository and do not copy them into test fixtures. Generate one image using
`codex_generate_image_artifact` with `save: "none"`, inspect its original pixels,
and display it by reading `result.artifact.path` and passing the returned image
block to `image()`. Report the reader's text note if no image block is returned.
Run `/image-artifacts`, reload, and recover the same file without regeneration.
Check that a nested call to `codex_generate_image` is unavailable without making
another image request. Do not retry an ambiguous connection/quota failure.
Do not use the separately billed API CLI.

For a one-off run without changing settings:

```bash
pi -e /path/to/pi-mono/packages/pi-codex-image-gen
```

To validate the Python CLI fallback without an API key:

```bash
uv run --no-project python3 skills/imagegen/scripts/image_gen.py generate --prompt "Test" --model gpt-image-2.5-flare --quality max --dry-run
uv run --no-project python3 skills/imagegen/scripts/image_gen.py generate --prompt "Test" --background transparent --output-format png --dry-run
uv run --no-project python3 skills/imagegen/scripts/remove_chroma_key.py --help
```

`npm test` requires Python 3 on PATH. CLI regression tests use only its standard library and make dry-run requests. Extension tests mock the backend; neither test path consumes image quota.

The vendored CLI changes for Images 2.5 cover documented quality and flexible size settings plus GPT Image 2 transparency preview. They do not change API endpoints, authentication, or defaults.

Optional live smoke test (requires explicit approval to use image quota): load this checkout with `pi -e`, generate one PNG, and edit it using `referencedImagePaths`. Verify inline display and saved bytes. Confirm that progress and the final summary do not invent an image model, and that `backendImageModel` is `"unknown"` unless the backend explicitly reports one. Verify `reportedImage` size/quality/background against the response, then inspect actual pixels for dimensions and alpha. A successful image does not prove which backend model ran. Never include credentials or raw image payloads in test reports.

For auth compatibility, run the smoke test with `/login codex-images` while chat uses `openai` OAuth. Verify the provider appears in `/login`, not `/model`, and that Pi persists the image credential under its own ID. Check `details.provider: "codex-images"` and `details.transport: "codex-responses"`. If legacy Pi `openai-codex` is available, test it separately without owned image credentials; it should report `openai-codex` / `codex-responses`. With both logins, owned image OAuth wins. A selected auth failure must not switch accounts. With only chat OAuth or an API key, the tool must ask for `/login codex-images` before any image request.

Test `/logout codex-images` without changing the chat login. On a remote/headless machine, test the full-redirect-URL fallback and callback-port conflicts. Never paste a callback into chat. Automated tests exercise actual provider registration, Pi login/storage/logout, PKCE/state, loopback/manual callbacks, cancellation, concurrent refresh, and image tool wiring using mocked token/image responses. They do not prove that a fresh live browser grant or a particular account supports the image endpoint.

On October 2, 2026, the maintainer reported that the package-owned flow worked in a live smoke test. This is a user-confirmed result, not automated verification of every account or of the served image model.

On October 2, 2026, live diagnostics with new `openai` plan-sharing OAuth rejected Responses image tools with `subscription_sharing_unsupported_capability`, and direct Images calls with `hardened_oauth_rule_missing`. OpenAI's [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) list image generation as unsupported. The same chat grant could call a local image function; separate image-capable Codex OAuth produced verified PNGs through both native Images and Codex Responses endpoints. These probes established the grant distinction, not a live test of this package-owned browser login.

## Subscription capability check

Checked on September 11, 2026, with a ChatGPT subscription token and no API-key billing. These observations are account- and date-specific, not a public API guarantee.

- Installed Codex `0.153.4` and upstream commit `4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042` both use the standalone images client for image generation. Its model is hard-coded to `gpt-image-2`; background, size, and quality are automatic.
- The request path is determined by subscription authentication: `https://chatgpt.com/backend-api/codex/images/generations` (or `images/edits`).
- A bounded diagnostic using the direct route generated an image. The existing Responses route also generated an image. All six returned PNG files passed Pillow verification and decoding.
- Requests naming Flare and Sunburst succeeded, but a deliberately invalid model name also succeeded. None reported a served model. Do not interpret HTTP 200 as proof of selectable models.
- An explicit `1536x1024`, `high`, `transparent` direct request returned `1254x1254`, `low`, `opaque`. Pixel inspection confirmed RGB output without transparency. Do not add guaranteed controls based on the request schema alone.
- GET diagnostics with the original Python client header returned a Cloudflare challenge. A package-specific Pi User-Agent reached method validation in the Python diagnostic. Cookie-free Node GET requests with the shipping headers reached the Responses route (405), but the direct route still returned a Cloudflare challenge (403). A User-Agent is not a universal challenge fix.
- The successful live generation probes used a Codex-compatible diagnostic User-Agent, a model-list warmup, and an in-memory allowlisted infrastructure-cookie jar. These were compatibility probes, not a live run of the modified extension. The shipping extension keeps an honest Pi User-Agent and does not copy that cookie/warmup flow.
- Model selection through the Responses tool, native transparency by prompting, and live editing were not established by this six-request check. Keep them separate from the proven baseline generation result.

Source references:

- [Installed Codex image tool](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/image-generation/src/tool.rs)
- [Subscription base URL selection](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/model-provider-info/src/lib.rs)
- [Images endpoint client](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/codex-api/src/endpoint/images.rs)
- [Codex client headers](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/login/src/auth/default_client.rs)

Future probes should use a known-working control, one changed setting at a time, an invalid-model control for selection claims, and decoded output checks. Obtain a generation budget first, bound time/response sizes, disable automatic retries, and record only sanitized metadata. Do not repeat an ambiguous failed generation automatically.

## Pull request checklist

Before opening a pull request:

- Run `npm run check`.
- Run `npm run pack:dry-run` and confirm the package contents are intentional.
- Update `README.md` if user-facing behavior changes.
- Update `CHANGELOG.md` for notable changes.
- Keep examples and paths generic; do not commit machine-specific paths or credentials.

## Coding guidelines

- Keep extension logic in `index.ts` unless there is a clear reason to split.
- When changing tool parameters, update both the Typebox `TOOL_PARAMS` schema and the `promptGuidelines` strings — Pi surfaces both to the model.
- Treat save-mode names, config file keys, and auth flow as public interface; changes to defaults or precedence are breaking changes.
- Do not modify `skills/imagegen/scripts/image_gen.py` without a documented reason; it is a vendored fallback.
- The Codex Responses SSE contract is private and may change. If generation breaks, inspect sanitized event types, status codes, and allowlisted output metadata. Never log raw response bodies or auth headers.
- Keep the Pi tool subscription-only: prefer package-owned `codex-images` OAuth, preserve available legacy Pi `openai-codex` support, and never use the `openai` chat token, Codex app credentials, or `OPENAI_API_KEY` for tool requests.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
