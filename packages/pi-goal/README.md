# @mocito/pi-goal

Give Pi a durable objective and let it keep working until the job is verified done.

`pi-goal` adds branch-aware, long-running goals modeled after Codex `/goal`, with automatic continuation, token budgets, progress visibility, and explicit completion checks.

## Features

- **Work beyond one turn** — Pi continues an active goal after successful runs, without restarting cancelled or failed work.
- **Persistent branch-aware state** — goals survive reloads and follow session trees, forks, and clones without leaking across divergent branches.
- **Budget control** — cap token use, monitor remaining budget, and pause or resume work at any time.
- **Visible progress** — track status, active time, token usage, and budget from Pi's UI.
- **Verified endings** — model tools require explicit completion evidence and stop repeated retries when work is blocked or provider limits intervene.

## Install

```bash
pi install npm:@mocito/pi-goal
```

Requires Pi 1.1.0 or newer for complete usage accounting and the settlement
and cache-warming hooks. Development and session-contract tests use Pi 1.1.0.
There is no legacy fallback for nested terminal updates.

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

`update_goal` is model-only: it remains available directly to the model with
codemode disabled, `on`, or `only`, but cannot be called from codemode scripts or
other tools through `ctx.executeTool()`. Run verification first, inspect the
results, then call `update_goal` as the only tool call in a separate final
assistant turn. `get_goal` and `create_goal` remain callable from scripts.

The extension enforces this call boundary, not the truth of the model's
verification evidence. Trusted extensions still run with the user's permissions.

### Structured script contract

On Pi 1.1.0 or newer, `get_goal` and `create_goal` declare output schemas:

- `get_goal` returns `{ goal: summary | null }`, including a stable `null` when
  no goal exists. Its direct no-goal text stays `No goal is set.`.
- `create_goal` returns `{ goal: summary }`. It still requires an explicit
  creation request; discovery metadata is not permission to create a goal.
- `summary` contains `goalId`, `objective`, `status`, `tokensUsed`,
  `timeUsedSeconds`, `createdAt`, `updatedAt`, and optional `tokenBudget`,
  `remainingTokens`, `activeStartedAt`. Internal accounting ledgers,
  verification metadata and branch entries are not included.

```js
const { goal } = await tools.get_goal({});
text(goal ? { status: goal.status, remainingTokens: goal.remainingTokens } : "No goal");
```

Remove old `JSON.parse(await tools.get_goal({}))` wrappers. Direct results remain
readable JSON and the renderers retain their summaries. Invalid requests and
creation conflicts throw; scripts must catch rejection. Neither tool uses a
structured success object with `isError: true`. Legacy oversized objectives remain
inspectable without silent truncation; new objectives retain the 4,000-character
input limit.

Await `describeNamespace("goal")`, `describeTool("get_goal")`, or
`searchTools("goal budget", { namespace: "goal" })`, including with zero inline
budget. No deferred/codemode-only option or default exposure change is added.
`update_goal` remains absent from nested discovery and has no output schema.

All goal tools run sequentially. `get_goal` is **not** annotated read-only because
it refreshes and can persist usage accounting; its repeated bookkeeping is
idempotent. Creation is non-idempotent. Terminal update is destructive and
non-idempotent. All are local-only, and the annotations are advisory, not
approval or evidence verification. Pi owns aggregation of nested usage; these
snapshots do not add a second usage report.

## Behavior

Goal state is stored as immutable `pi-goal` custom session entries and reconstructed from `ctx.sessionManager.getBranch()`, so state follows Pi session branches, tree navigation, forks, and reloads.

After a successful run, the extension accounts finalized usage and proposes a
hidden `pi-goal-context` message at Pi's actionable `agent_before_settle` boundary.
Pi finishes its retry, overflow recovery, compaction, and queued work before
reaching that boundary. Pi then validates the proposed context and owns the next
request; there is no post-run `agent_end` timer or new run from `agent_settled`.
A context filter keeps only the latest message for the current active goal.
Earlier messages remain in append-only session history.

Cancellation, terminal assistant errors, and failed/cancelled automatic
compaction suppress goal continuation for that run. Cancellation and ordinary
errors leave the stored goal active; they do not silently pause or clear it.
The compaction-failure stop survives queued steering/follow-up work and resets
only when the whole run reaches the notification-only `agent_settled` event.
Explicit new input can start work again. Use `/goal pause` to keep it paused.
Pending steering, follow-up, and user messages take priority and are not consumed
or duplicated by the goal extension.

Initial `/goal` commands, `/goal resume`, active session startup/reload, and tree
navigation retain a separate activation path because there may be no running
boundary. Tree activation waits for navigation to finish. Each activation
rechecks goal/session/branch identity, saved usage, idle state, and pending work.
A real run or a goal/session/branch transition invalidates an obsolete activation.
Resuming or reloading a session with an active goal can therefore restart it,
including after an earlier cancellation.

Boundary proposals preserve other extensions' entries and continuation requests.
The incoming `context.canContinue` describes the preview before the goal message:
it can be false after a normal assistant reply. The goal's custom-message draft
makes that preview runnable; Pi checks the final preview after all handlers.
Declining goal continuation does not veto another extension's continuation.

The TUI footer and optional editor widget show status, elapsed active time, token usage, and budget.
Print, JSON and RPC retain the goal lifecycle without terminal footer/widget updates.

Provider usage-limit handling pauses active goals when Pi exposes HTTP 429 responses or assistant error messages that indicate subscription, quota, billing, balance, or repeated provider failures. This prevents automatic continuation from retrying indefinitely after provider limits such as 5-hour subscription caps. When the budget is exhausted or a provider limit is detected, a visible `pi-goal-event` notice is saved to model context without requesting a wrap-up turn. The model can act on that notice during a request independently started by Pi, the user, or another extension; the notice itself does not spend more tokens.

### Token accounting and attribution

The goal counts reported tokens from finalized assistant messages, tool results,
standalone usage entries (including cache warming), compactions, and branch
summaries. Failed or cancelled calls count when Pi persists their usage.
Nested tool usage is already aggregated by Pi onto the parent tool result and
is counted once, not by walking nested calls. Cached input tokens count too.
This is a token budget, not a currency or provider-quota budget.

Virtual-model selections do not change that rule: Pi records the physical
assistant's usage, and codemode classifier usage is aggregated onto its parent
tool result. However, a raw `ctx.modelRegistry.classify()` call inside a router
does **not** automatically create a session usage entry in Pi 1.1.0. The goal
cannot charge an unrecorded result. Paid automatic routers need an explicit,
single-count attribution contract before they can be treated as budget-safe;
do not infer free classification from an unchanged goal total. Classifier
judgments are not completion evidence or permission to bypass approvals.

The accounting interval starts at the goal's creation/replacement entry and
ends when it is replaced or cleared on that branch. Earlier work is excluded,
including entries before creation with the same timestamp. Entries need valid
timestamps within the interval and no later than the scan time.
As in earlier v1 releases, **pause stops continuation, not accounting**:
work while paused, limited, blocked, or complete is still charged to the
retained goal. Clear or replace the goal before doing unrelated work.
Completion reports are snapshots of finalized usage at completion.

Accounting uses raw branch history, not the model-context projection. Compacted
or context-omitted billed attempts still count. Reloads and forks retain the
inherited entry-ID ledger; divergent branch work is not imported. A tree
summary's own usage belongs to the destination branch. Navigating back before
work was done restores that branch's earlier total, not a session-wide spend cap.

Schema-v1 mutations remain compatible; no migration or session rewrite is needed.
Previously accounted assistant tokens and IDs are retained. The next scan
backfills newly supported usage entries once, so old goals may show higher
totals or reach their budgets after upgrading.

Budget enforcement scans saved usage at turn end, before settlement, after
compaction/tree navigation, on reload, before scheduled continuation, and when
goals are queried or changed. Pi 1.1 has no extension notification for newly
saved idle usage, so a session-scoped one-second poll checks for branch changes
while idle. It does not make provider requests. A budget notice updates visible
state and model context **without requesting another model turn**.

### Idle cache warming

The extension requests `stop` at an idle warming decision when the retained
goal has a token budget or is `budget_limited`/`usage_limited`. It never requests
`warm`, changes Pi's settings, or overrides decisions for no-goal sessions or
unbudgeted, non-limited goals. Pi uses the last handler that returns an action;
a later extension can explicitly override this stop.

This policy is idle-only. It does not intercept every provider request, cancel
in-flight warming, or stop streaming-phase warming. Any persisted warming usage
within the goal interval is still accounted.

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
- If a goal stops unexpectedly, check whether the run was cancelled, failed, or hit a token budget/provider limit. Usage-limit pauses may include a provider reset hint. Budget/provider notices do not start another request; the goal remains `budget_limited` or `usage_limited` until explicitly resumed, cleared, or finalized during later work.
- If context appears stale after tree navigation or reload, run `/goal status`; branch state is reconstructed from the active branch.
- In print/JSON modes, commands and tools work, but interactive confirmations/editors are unavailable.

## Limitations

- Token budget is enforced after finalized usage is saved. It stops goal-driven continuation, not an in-flight provider call, Pi's own recovery, user-requested work, or another extension's continuation. Usage that a provider/tool does not report cannot be counted.
- Usage-limit handling is best-effort via HTTP responses and assistant error messages; provider transports vary in how much structured limit information they expose.
- Automatic continuation is session-local, not a background daemon.
- Oversized stored objectives (over 4,000 characters) are not automatically continued or silently truncated. Edit the objective before resuming.

## Development and validation

From the monorepo root:

```bash
npm install
npm run check --workspace packages/pi-goal
npm test --workspace packages/pi-goal
npm run pack:dry-run --workspace packages/pi-goal
npm audit --omit=dev
```

The session-contract suite uses real Pi loading, tool dispatch, provider
serialization, and session trees with synthetic goals and mocked provider
traffic. It checks direct and nested calls, codemode discovery, termination,
reloads, model changes, and branch reconstruction without live credentials or
provider requests.

Accounting regressions also cover multi-level metered codemode calls, failed
results, mocked cache warming and remote compaction, branch summaries, context
omissions, inherited fork histories, and tool-only budget exhaustion. The warming
tests load the compaction/reasoning hooks in both orders and verify that idle
refreshes do not change saved reasoning state.

The settlement suite exercises the production extension in real Pi sessions
with bounded mocked responses. It covers cancellation (including retry and
pre-settlement cancellation), successful/exhausted retries, compaction
success/failure, canonical context edits, user queues, extension ordering,
terminal tools, startup/resume/reload, replacement, forks, tree navigation, and
TUI/print/JSON/RPC bindings. It also advances controlled timers after settlement
to detect an obsolete timer that would restart the run. No live credentials are
used; HTTP responses are mocked and WebSocket traffic is blocked.

Run the focused lifecycle smoke test from the monorepo root:

```bash
node --import tsx --test packages/pi-goal/tests/settlement-contract.test.mjs
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
