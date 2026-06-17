---
title: "Resolve Compound Engineering skill resources through package runtime guidance"
date: 2026-06-17
category: developer-experience
module: pi-compound-engineering
problem_type: developer_experience
component: tooling
severity: medium
applies_when:
  - "A Pi package ships third-party Agent Skills that reference bundled scripts, references, or assets"
  - "The agent shell cwd differs from the active skill directory"
  - "Upstream skill content should remain portable and unforked"
tags: [pi-compound-engineering, compound-engineering, skill-resources, runtime-guidance, before-agent-start]
---

# Resolve Compound Engineering skill resources through package runtime guidance

## Context

`pi-compound-engineering` installs upstream Compound Engineering skills into a generated package layout. Those skills are portable Agent Skills and often refer to bundled resources with skill-local paths such as `scripts/`, `references/`, and `assets/`.

A Pi `/ce-setup` run exposed a portability seam: the agent initially tried package-root `scripts/check-health`, which does not exist, then discovered the real generated path at `skills/ce-setup/scripts/check-health`. A Claude Code `/ce-setup` baseline had an explicit skill base directory and ran the same bundled script directly (session history). The gap was not the upstream skill content; it was missing Pi runtime context about how package skill resources map to disk.

## Guidance

Prefer extension-provided runtime context before adding converter text rewrites for package-specific portability gaps. For CE skills, the package extension can teach the model the generated layout without mutating upstream `SKILL.md` files.

The pattern that shipped in PR #17 has three parts:

1. Render concise guidance that maps skill-local resources to generated package paths:
   - `scripts/<file>` -> `skills/<skill-name>/scripts/<file>`
   - `references/<file>` -> `skills/<skill-name>/references/<file>`
   - `assets/<file>` -> `skills/<skill-name>/assets/<file>`
2. Inject that guidance from `extensions/index.ts` through Pi's `before_agent_start` hook when a CE skill is relevant.
3. Guard injection using both prompt text and `event.systemPromptOptions.skills`, so natural-language prompts that cause the model to select a CE skill still receive the guidance.

The implementation lives in `packages/pi-compound-engineering/src/skill-resource-guidance.ts` and is called from `packages/pi-compound-engineering/extensions/index.ts`. It also includes the current package install directory so shell commands can use absolute paths rather than relying on the project cwd.

Keep the converter out of this class of fix unless runtime context cannot solve the issue. Converter rewrites are still appropriate for platform primitive translation, but resource-location guidance is better expressed by the extension that owns the installed package layout.

## Why This Matters

Runtime guidance preserves the recipe-only model. The package can keep fetching and converting upstream Compound Engineering releases while Pi-specific context stays in package code that is easy to test, document, and remove if Pi core later provides equivalent skill-base context.

This also reduces model trial-and-error. In the bogus-repo validation run, `opencode-go/deepseek-v4-flash` used `package.json` and `skills/ce-setup/scripts/check-health` directly instead of probing Claude-only `plugin.json` or package-root `scripts/check-health`.

## When to Apply

- A Pi package exposes third-party skills that contain relative resource paths.
- The resource paths are valid relative to the skill directory but ambiguous from the project cwd.
- The fix is about runtime orientation, not changing the upstream workflow.
- The package can determine the install directory at extension runtime.

Do not use this pattern for source content that is semantically wrong across harnesses. In that case, upstream the correction or add a carefully tested converter transform if upstreaming is blocked.

## Examples

### Extension hook

```ts
pi.on("before_agent_start", async (event) => {
  if (!shouldAppendCeSkillResourceGuidance(event.prompt, event.systemPromptOptions.skills)) return;
  return {
    systemPrompt: appendCeSkillResourceGuidance(event.systemPrompt, getPackageInstallDir()),
  };
});
```

The guard needs both inputs. Prompt matching handles explicit invocations like `/ce-setup`; `systemPromptOptions.skills` handles natural-language prompts where the model chooses a CE skill from the loaded skills list.

### Guidance shape

```text
For any Compound Engineering (CE) skill, map resources to <packageRoot>/skills/<skill-name>/... before reading or executing them: scripts/<file>, references/<file>, and assets/<file> live under that skill directory.
```

The guidance may include a concrete example, but the general rule should be the primary instruction. Otherwise the fix only helps the first observed skill and leaves the same resource-resolution bug available in the rest of the CE set.

### Verification

`npm run verify --workspace packages/pi-compound-engineering` should assert representative generated resources exist. For the observed failure mode, the check is:

```text
PASS  ce-setup bundled check-health script is present
PASS  ce-setup bundled check-health script is executable
```

Unit tests should cover:

- rendering package-relative and absolute guidance,
- idempotent append behavior,
- explicit `/ce-*` prompts,
- loaded CE skills from `systemPromptOptions.skills`, and
- unrelated prompts with unrelated skill lists.

## Related

- `docs/plans/2026-06-17-001-fix-pi-ce-setup-resource-resolution-plan.md`
- `packages/pi-compound-engineering/src/skill-resource-guidance.ts`
- `packages/pi-compound-engineering/extensions/index.ts`
- `packages/pi-compound-engineering/scripts/verify.mjs`
- GitHub PR: https://github.com/jvm/pi-mono/pull/17
