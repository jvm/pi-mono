<p>
  <img src="./banner.png" alt="pi-skillful" width="1100">
</p>

# pi-skillful

`pi-skillful` is a [Pi](https://pi.dev) package that improves skill workflows.

It currently provides three extensions:

- **Inline skill invocation**: invoke one or more skills anywhere in a prompt with `/skill:name`.
- **Skill prompt visibility**: choose which skills are hidden from the model's automatic skill-discovery prompt, while keeping them explicitly invokable and visibly marked in Pi's startup skill list.
- **Session skill toggles**: assign up to nine skills to number slots and toggle model visibility while writing a prompt.

> [!WARNING]
> Pi packages can execute arbitrary code through extensions. Review package source before installing any third-party Pi package.

## Features

### Inline skill invocation

Vanilla Pi expands `/skill:name` only when it appears at the beginning of the prompt. `pi-skillful` expands known skill markers anywhere in the prompt, including multiple skills:

```text
Use /skill:code-security and /skill:semgrep to review this change.
```

The extension replaces each known marker with that skill's `SKILL.md` content before Pi's built-in skill/template expansion runs.

### Skill prompt visibility

Hide skills from the `<available_skills>` section of the system prompt without editing each skill's `disable-model-invocation` frontmatter.

Hidden skills:

- are not advertised to the model for automatic skill selection;
- remain loaded by Pi;
- remain available for explicit invocation with `/skill:name`, including inline invocation.

Skills bundled in Pi packages are never affected by `skillful`; only global and project skills can be hidden or toggled.

Configuration is stored under the `skillful` key in Pi settings:

```json
{
  "skillful": {
    "hiddenSkills": ["pdf", "xlsx"]
  }
}
```

Supported scopes:

- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Project visibility and toggle slots inherit global settings until changed in the Project tab. When either is changed, Pi Skillful writes a full project override containing both `hiddenSkills` and `toggleSlots`. If the project state is changed back to match global, those project override keys are removed so the project inherits global again.

Open the menu with:

```text
/skillful
```

The menu lists configurable skills alphabetically. Toggle a skill off or on in the active scope. Use the Global/Project tabs to choose which settings file to edit. In the Project tab, inherited on/off values are shown normally; project overrides are highlighted. Press `1` through `9` on a selected skill to assign or clear that scope's session toggle slot. Visibility and toggle slots are independent.

Pi's startup `[Skills]` list also highlights hidden skills in the error color (red in the default dark theme).

When the project settings file contains only `skillful` settings and the project `hiddenSkills` list becomes empty, `.pi/settings.json` is deleted instead of leaving an empty settings file behind.

### Session skill toggles

Assign skills to up to nine prompt-editor slots with JSON settings:

```json
{
  "skillful": {
    "hiddenSkills": ["pdf", "xlsx"],
    "toggleSlots": {
      "1": "typescript",
      "2": "code-review",
      "3": "git"
    },
    "toggleModifier": "alt"
  }
}
```

Configured slots appear on the prompt editor's top border as `N skill-name`. Project `toggleSlots`, when defined as part of a project override, replace global `toggleSlots`; otherwise global slots are used and shown in the Project tab. Long names are truncated per slot when needed so all configured slot numbers remain visible. Active slots use the theme accent color; inactive slots use the muted color. Press `alt+1` through `alt+9` by default to toggle a slot for the current session only.

`toggleModifier` defaults to `"alt"`. Supported values are `"alt"`, `"ctrl"`, `"ctrl+shift"`, `"alt+shift"`, `"ctrl+alt"`, and `"ctrl+alt+shift"`. Change it if your terminal reserves `alt+number` shortcuts.

On app startup, non-hidden skills are active and hidden skills are inactive. Within a running Pi process, `/new` preserves the current toggle state for the new session. Resuming, forking, cloning, reloading, or restarting Pi resets toggle state from settings. Inline `/skill:name` invocation remains explicit and works even when that skill is inactive. Skills bundled in Pi packages are never modified by these toggles.

## Installation

Install from npm:

```bash
pi install npm:pi-skillful
```

Install project-locally with Pi's `-l` flag:

```bash
pi install -l npm:pi-skillful
```

During local development from this monorepo:

```bash
pi install /path/to/pi-mono/packages/pi-skillful
```

For a one-off test run without installing:

```bash
pi -e /path/to/pi-mono/packages/pi-skillful
```

## Usage

1. Start Pi in a project with this package installed.
2. Run `/skillful`.
3. Select the Global or Project tab.
4. Toggle skills on/off.
5. Send a prompt normally, or explicitly invoke hidden skills with `/skill:name` anywhere in the prompt.

Example:

```text
Please analyze this using /skill:code-security, then summarize the risk.
```

## Development

This package is source-distributed. Pi loads the TypeScript extensions directly via its extension loader.

Requirements:

- Node.js >= 20.6.0
- npm for local development commands

Common commands:

```bash
npm install
npm run check
npm run pack:dry-run
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and pull request guidelines.

## Security

Please report security issues privately. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
