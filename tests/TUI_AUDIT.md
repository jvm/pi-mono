# Pi 1.1.0 TUI contract audit

Scope: issue #167. This is a source/contract audit, not a claim that every listed
surface was broken. No provider call, image generation, credential lookup, or
user configuration change is needed.

## Automated evidence

Run from the repository root:

```sh
node --import tsx --test tests/tui-contracts.test.mjs
npm test -w packages/pi-skillful
npm test -w packages/pi-dcg
npm run validate
```

`tui-contracts.test.mjs` mounts actual Pi `ToolExecutionComponent` render shells
in both `TuiMainScreen` and `TuiAltScreen`. Its in-memory terminal implements
the Pi 1.1.0 `Terminal` contract, including `setProgramStatus`, and captures
output and resize handling. It does not mock the renderer or execute tools.

| Surface | Result and coverage |
| --- | --- |
| Patch call preview | Confirmed stale ANSI cache: invalidation did not clear the extension-owned preview. Clear it on invalidation. Existing previews repaint after dark/light/system changes, expansion, and resize without execution. |
| Skill toggle border | Confirmed captured theme reference and overflow below the fixed border prefix width. Read the current theme at render time and truncate the complete border. Package tests cover Unicode/wide names and widths 0–120. |
| Skill editor composition | Existing focus/IME marker and custom shortcut forwarding remain. Added paste, image-paste callback, padding, invalidation, disposal and preservation of inner working/compaction/retry lines. The wrapper decorates only the first line. |
| Startup Skills list | Retain #152's isolated private patch and real `InteractiveMode.showLoadedResources` coverage. Mount its resource container in both terminal engines with actual dark/light/system palettes, widths 24–120, expansion/collapse and repeated reload. Verify one Skills section, error/dim coloring, native expanded paths and no stacked wrappers. This audit does not replace the patch with an unrelated tool-renderer API. |
| Web call/progress/results | Real shell tests exercise partial progress, active spinner, palette changes, terminal error/cancellation-shaped output, expansion and resizing. The final result stops the spinner. Renderers recompute themed strings; no retained ANSI cache was found. |
| Goal | Message renderers use the supplied theme and wrap restored text. Footer/widget state is plain text, not cached ANSI. Add explicit TUI-only guards for footer/widgets; model state/accounting and RPC notifications are unchanged. |
| Fast/DCG footer | Confirmed persistent theme-colored status strings. Pi's status API stores text rather than render callbacks, so use palette-neutral state labels instead of a private theme watcher or polling. DCG notifications/approvals still work through RPC; only terminal footer writes are TUI-only. |
| Insomnia | Spinner text is palette-neutral. Guard terminal status/timer creation by `mode === "tui"` while preserving sleep-inhibitor lifecycle in other modes. |
| Compaction notice | The old persistent legacy Codex notice was removed with PR #174's public automatic-compaction migration. Current adoption records bounded custom diagnostics, not a themed legacy notice. Do not restore removed transport/UI code for this audit. |
| Images | Existing one-pixel PNG fixture renders through Kitty and regular-mode iTerm2. Pi itself disables iTerm2 inline images in fullscreen; verify text fallback there. Unsupported terminals and hidden images use fallback without generating another asset. |
| HTML export | Actual `AgentSession.exportToHtml` pre-renders registered patch/web calls and terminal error results from persisted synthetic entries. Check that fixture markup is escaped in rendered HTML. No browser pixel/layout claim is made. |

Tool shells own `outputPad`; the extensions continue using zero-padding `Text`
components and do not double-pad. No elapsed-time display is added, so no
wall-time reconstruction is introduced; recorded `durationMs` remains host-owned.
No extension customizes another tool's display, so `registerToolRenderer` is not
needed and executor registration/activation is unchanged.

## Validation record

Local validation: Pi 1.1.0 with Node 24.21.0 passed full `npm run validate`
across all 13 packages, including 11 new root UI/export contracts. Node 22.19.0
passed those contracts and all six changed package suites. Pack dry-runs exclude
tests/audit notes and generated builds. Semgrep `p/default` reported no findings
on the six changed runtime files; this is not a proof of absence of vulnerabilities.
The same UI contracts against pre-change source fail five cases, and the new
Skillful border contract also fails there, establishing regression sensitivity.

## Remaining physical-terminal acceptance

The in-memory terminal smoke covers engine behavior, not pixels, actual IME
candidate placement, terminal theme-query responses, mouse selection, or emulator
image placement. These require a real-terminal acceptance pass before claiming
all of #167 complete. HTML export browser layout is not certified by the
serialized-output test.

Use a disposable profile, not the normal Pi settings or auth store. Disable
telemetry and network (`PI_OFFLINE=1`, `PI_TELEMETRY=0`), create one visible and
one hidden synthetic skill, and configure one toggle slot. Use the package's
documented one-run extension loading commands, with the installed Pi 1.1.0
baseline. Do not sign in or send model prompts for the visual checks.

1. Start once with `--tui-mode regular` and once with `--tui-mode fullscreen`.
2. Use `/settings` to switch dark/light/system while existing content is visible.
3. Expand/collapse startup resources; verify error/dim skill colors and native paths.
4. Resize narrow/wide and test Unicode input, paste, focus and IME cursor placement.
5. Toggle the configured skill; inspect border colors without another turn.
6. Run `/reload` twice; verify one Skills section and no stacked editor decoration.
7. Display an existing PNG fixture on supported terminals; do not generate an image.
8. Check `/export` on synthetic history separately where host export supports it.

Keep #148 open until its actual installed-version/release and physical-terminal
acceptance status is reconciled. Passing source tests do not install an unreleased
fix. Hardware/fake-cursor APIs beyond the pinned release remain a future upgrade
watch item, not part of this change.
