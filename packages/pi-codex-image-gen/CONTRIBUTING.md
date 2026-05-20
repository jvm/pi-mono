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

Then run `/login` for `openai-codex` and ask Pi to generate an image.

For a one-off run without changing settings:

```bash
pi -e /path/to/pi-mono/packages/pi-codex-image-gen
```

To validate the Python CLI fallback without an API key:

```bash
python3 skills/imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/test.png --dry-run
python3 skills/imagegen/scripts/remove_chroma_key.py --help
```

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
- The Codex Responses SSE contract is undocumented and may change. If generation breaks, log raw events before assuming a code bug.
- Avoid requiring `OPENAI_API_KEY` for the normal Pi tool path; auth piggybacks on Pi's `openai-codex` login.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
