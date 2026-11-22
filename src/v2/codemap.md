# OpenCode 2 adapter

Slim requires **OpenCode 2.3.0+**. `src/plugin.ts` exports `{ id, setup }`
and loads `setup.ts`, which adapts the shared factory's V1-shaped hooks into
OpenCode 2 registrations. This is an internal calling convention, not a V1
runtime entry point. `types.ts` mirrors the consumed Promise hook surface;
`mirror-conformance.ts` checks it against `@opencode/plugin` 2.3.2 at typecheck.
That pin is not integration coverage for every provider or unreleased host.

[Installation](../../docs/installation.md) covers package loading and upgrades;
[Background Orchestration](../../docs/background-orchestration.md) and
[Tools](../../docs/tools.md#background-task-control) own the lifecycle and
control contracts. The host owns execution, Jobs, delivery and recovery. Slim
keeps no child-job ledger or secondary completion path.

## Setup and policy

- Reduced TUI/registration-only contexts skip server activation. Full setup
  registers the MCP transform before the agent transform. The callbacks capture
  host namespaces and then freeze the finalized managed registry, without forcing
  `ctx.agent.list()`. A missing required transform, premature finalization or
  session-hook registration failure does not silently run incomplete policy.
  Managed prompt admission fails closed until registry readiness.
- `adapters.ts` maps ordered `bash`/`task` declarations to native `shell`/`subagent`
  rules, retaining order. `execute` is a separate Code Mode action, not an inner
  tool grant. Dynamic asks use native `permission.assert`; a reduced host without
  it cannot enforce those asks. Configured host MCP entries win their namespace.
- `permission-rules-bridge.ts` and the prompt bridge apply child policy before
  first inference via `session.update({sessionID, permissions})`, which replaces
  the session rules. Project the finalized host policy and Slim-owned ceilings;
  do not replay old allows over stricter rules or widen resource exceptions.
  Host `experimental.policies` denies remain final. Identity/agent changes can
  trigger reprojection; unresolved required identity or policy admission fails.
- Prompts, permissions, registrations, and Skill/MCP grants are frozen for a
  generation. Foreign agents keep their native configuration. Startup and
  refreshed profiles share config snapshots; a failed refresh retains the last
  valid state. Marketplace reports desired/live differences, not a claimed host
  reload. A native reload creates a new generation and disposes owned resources;
  ESM module state can survive. See [Runtime efficiency](../../docs/runtime-efficiency.md).

## Host session calls

`client-shim.ts` exposes only capabilities present on the host. It maps the
shared factory's session operations without inventing successful results:

| Shared factory call | Native contract |
|---|---|
| `session.get` | Native identity/state lookup |
| `session.abort` | `session.interrupt({sessionID, resume: false})`; acceptance does not prove cleanup |
| `session.messages` | `session.context`, retaining relevant finish/error data and lifecycle markers |
| `session.prompt` | Steer by default; `noReply` means queue with `resume: false` |
| `session.update` | Update title |
| `session.list` | Consume cursor pages through the terminal page within 1,000 sessions / four seconds; never return an incomplete inventory |
| `session.delete` | Native remove |

An explicit agent in a shared-factory prompt asserts the stored session agent;
it does not select another one. Plugin-initiated submissions must preserve
session identity. Unverified ownership and unsupported per-call model/variant
changes fail before admission. The synchronous `beforeSend` check runs after
identity validation and is not forwarded to the host. `session-submit.ts`
shares native command-marker submission between command and Interview paths.

## Request shaping

- `prompt` observes external intent before awaits, admits child permission and
  inference policy, and tracks internal admissions separately. Native
  `session.model.request` can stamp the Copilot internal-initiator header only
  for supported request kinds when `chat-headers` is enabled.
- `context` replays command markers, applies the active message transforms and
  shapes system and request options. User attribution uses native identity or
  stored `agent-switched` markers when absent; already-attributed completion
  notices no longer trigger a history read for retired observer timestamps.
  Interview has one V2 owner in `interview-bridge.ts`.
- `generate` reuses idempotent system/profile shaping for a matching warm-up
  prefix; it does not replay turn-dependent message transforms. Title requests
  do not get Orchestrator instructions. The adapter collapses system text parts
  for provider compatibility; native segmentation/instruction metadata does not
  survive that text seam for later custom hooks.
- `compaction` strips Slim-tagged reminders without discarding native replay
  metadata or results. Council follows the host checkpoint template instead of
  its normal report format. When tagged content is present, the context bridge
  copies the last eligible part for one ephemeral cache hint, skipping volatile
  messages. See [Cache Verification](../../docs/cache-verification.md).
- `retry` steers native decisions when foreground fallback is available. Refusal
  and no-route continuations use the latest user, synthetic or completed
  compaction anchor. They reuse the same session; child completion stays native.

## Delegation and events

`delegation.ts` normalizes native `subagent` parameters for shared before/after
hooks, translating edits back. Before-hook rejection reaches the host. After
hooks preserve error versus completion and are omitted when no consumer or
preset admission capture needs them. Council's `Seats:` rewrite reads verified
host results on demand, independently of Slim task controls.

`event-subscription.ts` freezes the needed event types. `event-adapter.ts`
passes raw events first and maps their `data` to the shared consumers' shapes:

- Native execution events supply busy/terminal observations and preserve the
  host timestamp as `activityAt`; shutdown interruption is raw-only. A consumer
  of both mapped idle forms must be idempotent, as must permission consumers
  that see raw and mapped forms of the same request.
- Identity, move and deletion serve policy, directory scope and cleanup;
  mapped deletion carries the ID spellings the existing consumers use.
- `session.step.ended` supplies per-request cache telemetry, not cumulative
  usage. Refusal evidence uses correlated started/failed step events.
- Companion receives selected permission/form events. MCP elicitation forms
  owned by the global sentinel session are not mapped to session questions.
  Interview subscribes to text events only while enabled.

## Session presets and TUI

`session-presets.ts` persists resolved inference bundles, not permissions.
`backgroundJobs.mode: "off"` defaults `sessionPresetRouting` off: no store,
profile bridge, session RPC or executor wrapper. A sidebar/retry consumer can
still need profiles; with none, even the startup seed is skipped. Foreign
native targets do not receive Slim bindings or chains.

`admission-view.ts` shares validated identity and binding facts with profile
capture. Direct children inherit the parent's bundle before their first
request. A same-agent continuation can take a changed parent profile via the
native progress hook; an independently applied child bundle still governs its
future delegations. Native submit precedes the snapshot commit. A commit
failure reports an error without claiming the submitted run did not start.
[Preset Switching](../../docs/presets/preset-switching.md) owns user-visible
scope and persistence semantics.

`preset-command.ts` applies a session binding and returns feedback through
command rejection (no non-turn result channel). The TUI `/preset` paths use
the same apply helper via RPC or write the global default and request refresh.
`--force-orchestrator` (ADR-005) extends the same apply: on a root session it
switches the live model via `session.switchModel`, stores a `rootForce`
record consumed by a later native pick, and shapes the root request options
in the context handler while active.
`disabled_commands: ["preset"]` removes UI/command/RPC entry points, not internal
admission. TUI commands use the host keymap provider and dialogs;
`question-timeout-tui.ts` handles eligible forms only in an attached Slim TUI.
Panes require the shared service or an explicit `--server` (see
[deployment modes](../../docs/multiplexer-integration.md#deployment-modes)).

## Verification

- `mirror-conformance.ts`: compiled hook/type membership.
- `setup-feature-gates.test.ts`, `permission-rules-bridge.test.ts`, and
  `setup-command.test.ts`: gates, identity, child-policy and request bridges.
- `src/hooks/cache-safety.property.test.ts` and snapshots: rendered prefix safety.
- `scripts/verify-v2-native-lifecycle.ts`: packed plugin against its specified
  real host and mock provider, including off-mode Council and Observer.

Mock inference does not establish real model quality, TUI visibility, Companion
behavior or recovery exactly-once for external effects.
