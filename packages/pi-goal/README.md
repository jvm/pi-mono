# @mocito/pi-goal

Persistent long-running goals for Pi, modeled after Codex `/goal`.

## Install

```bash
pi install npm:@mocito/pi-goal
```

For local development:

```bash
pi -e ./packages/pi-goal
# or
pi -e ./packages/pi-goal/extensions/index.ts
```

## Commands

- `/goal` or `/goal status` — show current goal and usage.
- `/goal <objective>` — create or replace the branch goal.
- `/goal --budget 50000 <objective>` — create a budgeted goal.
- `/goal edit` — edit the objective in a multiline editor.
- `/goal pause` — pause automatic continuation.
- `/goal resume` — resume automatic continuation.
- `/goal clear` — clear the current branch goal.
- `/goal budget 50000` — set/update token budget.
- `/goal budget clear` — remove token budget.

Replacing a non-complete goal asks for confirmation when UI is available.

## Model tools

- `get_goal` returns current goal state and remaining budget.
- `create_goal` creates a goal only when explicitly requested and fails if one already exists.
- `update_goal` lets the model mark a goal `complete` or `blocked` only. It should mark complete only after requirement-by-requirement verification, and blocked only after the same blocker repeats for at least three goal turns.

## Behavior

Goal state is stored as immutable `pi-goal` custom session entries and reconstructed from `ctx.sessionManager.getBranch()`, so state follows Pi session branches, tree navigation, forks, and reloads.

When an active goal is idle, the extension injects a hidden `pi-goal-context` message and triggers another turn. A context filter keeps only the latest goal context message for the current goal to avoid linear context growth.

The footer and optional editor widget show status, elapsed active time, token usage, and budget.

Provider usage-limit handling pauses active goals when Pi exposes HTTP 429 responses or assistant error messages that indicate subscription, quota, billing, balance, or repeated provider failures. This prevents automatic continuation from retrying indefinitely after provider limits such as 5-hour subscription caps.

## Examples

Simple goal:

```text
/goal update the README with installation instructions
```

Budgeted goal:

```text
/goal --budget 50000 refactor the parser and run the test suite
```

Pause and resume:

```text
/goal pause
/goal resume
```

Branch behavior: goal mutations are stored on the current session branch. If you use `/tree`, `/fork`, or `/clone`, Pi Goal reconstructs the goal from that branch only, so divergent branches can have different goal state.

## Configuration

v1 has no user-facing goal configuration. Automatic continuation is enabled for active goals and stops when the goal is paused, blocked, complete, usage-limited, budget-limited, cleared, or when pending user messages exist.

Environment flags:

| Flag | Description |
| --- | --- |
| `PI_OFFLINE=1` | Disables install/update telemetry. |
| `PI_TELEMETRY=0` | Disables install/update telemetry. |

## Troubleshooting

- If continuation does not start, run `/goal status` and confirm the goal is `active`.
- If a goal stops unexpectedly, check whether it reached its token budget or the provider returned a rate/usage limit. Usage-limit pauses may include a provider reset hint when one is available.
- If context appears stale after tree navigation or reload, run `/goal status`; branch state is reconstructed from the active branch.
- In print/JSON modes, commands and tools work, but interactive confirmations/editors are unavailable.

## Limitations

- Token budget is enforced after finalized assistant usage is visible; v1 cannot hard-stop mid-turn.
- Usage-limit handling is best-effort via HTTP responses and assistant error messages; provider transports vary in how much structured limit information they expose.
- Automatic continuation is session-local, not a background daemon.

## Development and validation

From the monorepo root:

```bash
npm install
npm run check --workspace packages/pi-goal
npm test --workspace packages/pi-goal
npm run pack:dry-run --workspace packages/pi-goal
npm audit --omit=dev
```

Before publishing, also run the root validation loop:

```bash
npm run validate
```

## Publishing

`@mocito/pi-goal` is published independently from this workspace. Release tags use the monorepo package format:

```text
@mocito/pi-goal@0.1.0
```

Use the project-local release command from the repository root when possible:

```text
/release-package @mocito/pi-goal 0.1.0
```

## Security and privacy

Pi packages execute arbitrary code with your user permissions. Install only from sources you trust.

`pi-goal` does not require API keys and does not read provider credentials. Goal state is stored in local Pi session entries and goal objectives may be sent to the active model as hidden continuation context. Do not put secrets, credentials, tokens, or private data into goal objectives.

On startup, Pi Goal sends a best-effort install/update telemetry ping once per package version unless Pi telemetry is disabled, offline mode is enabled, or Pi runs in CI. See [SECURITY.md](./SECURITY.md) for the full security model and reporting instructions.
