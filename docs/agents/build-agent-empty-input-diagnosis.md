# Diagnosis: "build agent empty input" after orchestrator output

**Status:** Resolved repo-wide and guarded by a regression scan.
**Date:** 2026-08-10 (interview fix) · 2026-09-02 (repo-wide fix + scan)
**Related PR:** #818 (`fix/preset-tui-slash-command`) — same root class as the original `/preset` fix.
**Suspected sibling bug reported by user:** During `superpowers` / `brainstorm` skill conversations, when the orchestrator asks for confirmation or work is interrupted (subagent completes, background task finishes), a `build` agent turn sometimes appears with an empty user input.

## TL;DR

The `build` agent turn with empty input is **the same class of bug** as the original `/preset` issue fixed in #818: a plugin hook calls `sessionSdk.promptAsync({ body: { parts: [createInternalAgentTextPart(...)] } })` **without specifying an `agent` field**. opencode then resolves the agent via `agents.defaultInfo()`, which falls back to the built-in `build` agent whenever `default_agent` is unset, user-overridden, or not effectively applied. The `synthetic: true` flag hides the injected text from the TUI, so the user perceives the `build` turn as having "empty input."

**Update (2026-09-02):** every plugin-initiated prompt now names its agent.
`src/utils/prompt-agent.ts` owns the decision (`resolveSessionAgent()` +
`withAgent()`), the last two agent-less call sites (interview `notify`,
smartfetch's secondary model) were fixed, and
`src/utils/prompt-agent.test.ts` scans all of `src/` so a new agent-less
`session.prompt`/`promptAsync` body fails the build. The root cause was
confirmed empirically — see [Empirical confirmation](#empirical-confirmation-probe-a2):
the rewrite lands on accept (HTTP 204, before generation) and persists for
every later turn.

## Empirical confirmation (probe A2)

Measured against opencode **1.18.26** in an isolated temp project with a
purpose-built `probe-sub` subagent. A background child session was started,
then prompted directly with `agent` deliberately left out of the body:

```ts
client.session.promptAsync({
  path: { id: childID },
  body: {
    model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    // agent omitted
    parts: [{ type: 'text', text: 'Additional instruction: also report the current date.' }],
  },
});
```

Raw result:

```
child = ses_f9dec1daaffecKR4yLMGtcRPLQ  agent=probe-sub  title="a2-slow-count (@probe-sub subagent)"
child agent BEFORE prompt:        probe-sub
promptAsync(child, no agent) ->   HTTP 204  error=null
child agent IMMEDIATELY after:    build
child agent AFTER turn:           build
>> agent field CHANGED probe-sub -> build
```

Per-message agent attribution shows the session was genuinely re-homed, not
just mislabelled — the injected turn was served by `build`, with `build`'s
prompt and toolset, inside a session that is still a `probe-sub` subagent
child:

```json
[
  { "role": "user",      "agent": "probe-sub" },
  { "role": "assistant", "agent": "probe-sub" },
  { "role": "user",      "agent": "build" },
  { "role": "assistant", "agent": "build" }
]
```

The same run also established two facts the resolver relies on:

- **Assistant messages are not a safe agent hint.** They report whichever
  agent *served* a turn, which includes core's `compaction` / `summary` /
  `title` primaries — and includes `build` in any session this bug already
  re-homed. Only the newest **user** message is used.
- **`mode: subagent` is not enforced at the session level.** A parentless
  top-level session can be created and driven with a subagent-mode agent
  (`POST /session {agent:'explore'}` → 200, `promptAsync` → 204, `GET
  /session/:id` still reports `explore`). `mode` only controls where an agent
  is *offered*, so the resolver may return such a name and must not
  "correct" it.

Control: the identical prompt **with** `agent` supplied explicitly left
`session.agent` untouched and the injected instruction still steered the
child — so naming the agent is a complete fix, not a workaround.

## Root cause (causal chain, cross-validated)

1. **Orchestrator enters input-wait.** After emitting a confirmation question (skill flow), the assistant turn finishes. opencode's per-session Runner transitions to `Idle` (`packages/opencode/src/effect/runner.ts:115-138`, `packages/opencode/src/session/run-state.ts:60-63`). The session is no longer "busy" from the Runner's perspective.

2. **Plugin hook fires `promptAsync` with a synthetic part and historically no `agent` field.** The interview service now delegates these calls through `InterviewSessionRuntime`, whose v1 implementation supplies `agent: 'orchestrator'`; the v2 bridge uses the v2 orchestrator session API directly.
   - Continuation nudge (`continuation-evaluator.ts`) sets `agent: 'orchestrator'` and only runs when `continueOnIdle` is enabled.

3. **opencode does not guard `promptAsync` against busy/input-wait state.** The HTTP handler at `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:311-329` does not call `assertNotBusy` and does not consult the Question service. It proceeds straight to `promptSvc.prompt`. The Runner, being `Idle`, immediately `startRun`s the new turn (`runner.ts:131-134`). No queue, no reject, no cancellation of the pending question.

4. **Agent resolves to `build`.** `packages/opencode/src/session/prompt.ts:636-637`:
   ```ts
   const agentName = input.agent
   const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
   ```
   When `input.agent` is omitted, opencode uses `agents.defaultInfo()` (`packages/opencode/src/agent/agent.ts:328-340`), which returns the first visible `mode: "primary"` agent — **`build`** (declared first in the agent registry, `agent.ts:141-155`). omos attempts to set `default_agent = "orchestrator"` via its `config` hook (`src/index.ts:546-551`), but only when `default_agent` is absent. `build` is selected whenever:
   - `config.setDefaultAgent === false` (plugin config disables it)
   - The user's `opencode.json` already sets a different `default_agent`
   - The `config` hook didn't run or didn't apply (SDK/runtime version skew: plugin built against `@opencode-ai/sdk` v1.4.3, installed runtime v1.18.3)
   - The orchestrator agent isn't registered at config-load time

5. **"Empty input" is the synthetic flag's visual effect.** `synthetic: true` only controls TUI visibility. `packages/opencode/src/session/message-v2.ts:206` still includes synthetic text parts in model messages (the only filters are `!part.ignored` and `part.text !== ""`; there is no `synthetic` filter when building model messages). The user sees the `build` agent respond to a turn with no visible user message — perceived as "empty input." (`createInternalAgentTextPart` appends a `\n<!-- SLIM_INTERNAL_INITIATOR -->` marker, so the text is non-empty from the LLM's perspective.)

6. **Session agent is durably corrupted.** `packages/opencode/src/session/prompt.ts:672-689` compares `current.agent !== info.agent` and, if they differ, calls `sessions.setAgentModel({ agent: info.agent, ... })`. A single agent-less `promptAsync` that resolves to `build` **permanently rewrites the session's agent to `build`** — every subsequent turn also routes to `build` until explicitly reset.

## Confirmed-affected call sites

| File:line | Trigger | Body omits `agent`? | Gate |
|---|---|---|---|
| `src/hooks/task-session-manager/continuation-evaluator.ts` (`promptAsync`) | `session.idle` / `session.status(idle)` on orchestrator session with incomplete todos when the opt-in beta `backgroundJobs.continueOnIdle` is `true` | **No** (`agent: 'orchestrator'`) | `continueOnIdle`, process-local one-attempt gate (reserve→commit), `hasInputWait`, `isCurrentContinuation`, `isFallbackInProgress`, `backgroundJobBoard.hasTerminalUnreconciled`, malformed/active SDK short-circuits |
| `src/interview/service.ts` | User submits interview input | **No** — uses `InterviewSessionRuntime.continue()`, which passes `agent: 'orchestrator'` | `sessionBusy` lock, interview active state |
| `src/interview/runtime.ts` (`notify`) | Interview URL notification | **Fixed 2026-09-02** — was `Yes` (`noReply` suppresses the turn, not the agent rewrite); now resolves the session's own agent via `resolveSessionAgent()` and falls back to `orchestrator` only for a probe-confirmed parentless session | none |
| `src/tools/smartfetch/secondary-model.ts` | Smartfetch secondary model query | **Fixed 2026-09-02** — was `Yes`; now `withAgent(body, FALLBACK_HELPER_SESSION_AGENT)` = `build`, deliberately not `orchestrator` (which would make the task-session-manager adopt the throwaway helper as a managed orchestrator session) | none |

All remaining v1 SDK prompt sites already named their agent and are covered by
the scan: `src/hooks/orchestrator-wake/index.ts` (`agent: 'orchestrator'`),
`src/tools/task-revive.ts` (`agent: current.agent`), `src/tools/task-message.ts`
(`agent: job.agent`, reached through a `session.prompt.bind(session)` alias),
`src/hooks/foreground-fallback/index.ts` (sticky `agentName`), and
`src/interview/runtime.ts` (`continue`). `src/v2/session-submit.ts` prompts the
**v2 host** API, whose flat `PromptInput` has no `agent` field at all (agent
selection there is `session.switchAgent`), so it is allow-listed with that
reason.

## Correct pattern (for comparison)

`src/hooks/foreground-fallback/index.ts:635-639` explicitly includes the agent:
```ts
const promptBody = {
  parts: lastUser.parts,
  model: ref,
  ...(agentName ? { agent: agentName } : {}),
};
```
This is the pattern every `promptAsync` caller in omos should follow.

## Why the `hasInputWait` gate in task-session-manager is not sufficient

The gate exists and works in the common case (see `continuation-evaluator.ts` and
`task-session-manager/index.test.ts` continuation cases). Notes:

1. **Continuation is opt-in beta.** `backgroundJobs.continueOnIdle` defaults
   to `false`; set it to `true` to enable continuation SDK calls. Idle
   reconciliation remains active either way. When enabled, a process-local
   reserve/commit gate allows at most one `promptAsync` per session epoch
   between real user messages.

2. **Documented race window (when enabled).** `IDLE_RECONCILE_DELAY_MS = 2_000`.
   The idle-reconciliation comment admits late completions can still race the
   window. If `session.idle` fires and the timer expires before
   `question.asked` is delivered, and the SDK liveness reads resolve before the
   wait is tracked, a nudge can still fire.

3. **Input-wait is not the only trigger.** The interview/skill path
   (`src/interview/service.ts`) does **not** consult `hasInputWait` at all — it
   injects on user dashboard actions, which can happen while the orchestrator is
   mid-question. Its continuation routing is nevertheless explicit now.

4. **Continuation path sets `agent: 'orchestrator'`.** The historical missing-
   `agent` misroute on the continuation nudge is fixed in
   `continuation-evaluator.ts`; interview uses its runtime boundary as well.
   Smartfetch remains outside this interview fix.

## Why this is the same class as the #818 `/preset` fix

#818's original bug: `/preset` used `createInternalAgentTextPart()` to trigger an LLM turn that was invisible in the TUI (`synthetic: true`). The fix moved `/preset` to pure TUI dialogs (`src/tui-preset.ts` uses only `api.ui.dialog` / `DialogSelect` / `DialogPrompt` / `DialogConfirm` — no `promptAsync`).

The historical bug used the same `createInternalAgentTextPart` + `promptAsync`
pattern and omitted `agent`, so the invisible turn could route to `build` instead
of the orchestrator. The interview path no longer makes those raw calls.

## Fix implemented

The interview service no longer owns raw session prompt calls. Its narrow
`InterviewSessionRuntime` boundary routes all continuation prompts to the
orchestrator. v1 uses the nested SDK client; v2 uses a marker/context bridge and
the v2 session methods without expanding the global client shim.

Repo-wide (2026-09-02): `src/utils/prompt-agent.ts` is the single source of
truth for the `agent` field.

- `resolveSessionAgent(client, sessionId, opts)` resolves in order: recorded
  hint → `session.get().agent` → newest **user** message agent → fallback.
  Assistant messages are never used as a hint (they report whichever agent
  *served* a turn — including core's `compaction`/`summary`/`title` primaries,
  and including `build` in a session this bug already re-homed), and the
  `SYSTEM_AGENTS` denylist rejects those names at every derived step.
- The fallback applies only to a session confirmed parentless (or declared
  plugin-owned via `assumeTopLevel`); an unresolvable child session gets no
  `agent` field rather than a guess, because guessing would cause the very
  rewrite this module prevents.
- Plugin-created helper sessions pass `FALLBACK_HELPER_SESSION_AGENT`
  (`build`), never `FALLBACK_TOP_LEVEL_AGENT` (`orchestrator`).
- `withAgent(body, agent)` attaches the field and gives the regression scan one
  recognizable shape.

### Hardening (optional, larger scope)
1. **Input-wait guard on the interview/skill path.** Consult `hasInputWait` (or an equivalent signal) before injecting in `src/interview/service.ts`. Do not inject while the orchestrator is waiting for user input.
2. **Post-injection agent assertion.** After each `promptAsync`, assert `current.agent` was not changed out from under the orchestrator; if it was, restore it via `setAgentModel`.
3. **Investigate the `default_agent` application reliability** on opencode v1.18.x. The plugin was built against `@opencode-ai/sdk` v1.4.3; the installed runtime is v1.18.3. The `config` hook's `default_agent = 'orchestrator'` mutation may not be applied reliably under this skew. (Note: #799 tracks the package upgrade.)
4. **Shrink or eliminate the `IDLE_RECONCILE_DELAY_MS` race** for sessions that have a pending `question.asked` / `permission.asked`.

## Evidence index

### omos source
- **Continuation nudge (fixed agent + opt-in beta + one-attempt gate):** `src/hooks/task-session-manager/continuation-evaluator.ts`, `continuation-attempt-gate.ts`, `backgroundJobs.continueOnIdle` in `src/config/schema.ts`
- **Missing `agent` field (skill flow):** `src/interview/service.ts:622, 871, 933, 1007`
- **Correct pattern for comparison:** `src/hooks/foreground-fallback/index.ts:635-639`
- **omos sets `default_agent` only when absent:** `src/index.ts:546-551`
- **`createInternalAgentTextPart` produces `synthetic: true`:** `src/utils/internal-initiator.ts:9-21`
- **`CONTINUATION_NUDGE` is non-empty:** `src/hooks/task-session-manager/continuation-evaluator.ts`
- **`hasInputWait` / continuation gates:** `continuation-evaluator.ts`, `input-wait-tracker.ts`
- **`IDLE_RECONCILE_DELAY_MS` race window:** `src/hooks/task-session-manager/index.ts` (`IDLE_RECONCILE_DELAY_MS`)
- **`disableDefaultAgents` preserves `build` and `plan`:** `src/cli/config-io.ts:564-600`

### opencode source (`anomalyco/opencode` @ `dev`)
- **`promptAsync` HTTP handler (no busy/input-wait guard):** `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:311-329`
- **`prompt` HTTP handler (no guard):** same file, `:295-309`
- **Internal `prompt` always starts a new turn:** `packages/opencode/src/session/prompt.ts:1052-1071`
- **Agent selection: `input.agent ?? defaultInfo()`:** `packages/opencode/src/session/prompt.ts:636-637`
- **`defaultInfo()` → `default_agent` or first visible primary:** `packages/opencode/src/agent/agent.ts:328-340`
- **`build` agent definition (default primary, first in registry):** `packages/opencode/src/agent/agent.ts:141-155`
- **Destructive `setAgentModel` overwrite on agent change:** `packages/opencode/src/session/prompt.ts:672-689`
- **Synthetic parts included in model messages:** `packages/opencode/src/session/message-v2.ts:206`
- **Runner `ensureRunning` (Idle = run now, no queue):** `packages/opencode/src/effect/runner.ts:115-138`
- **Runner Idle transition on turn end:** `packages/opencode/src/session/run-state.ts:60-63`
- **`assertNotBusy` (NOT used by prompt/promptAsync):** `packages/opencode/src/session/run-state.ts:71-75`

### SDK types
- **`default_agent` doc: "Falls back to 'build' if not set or invalid":** `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1255-1257`
- **`SessionPromptAsyncData.body.agent?` is optional:** `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:3241-3269`
- **`build` is a built-in agent:** `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1273-1279`

## Follow-up

1. Continue keeping cache-sensitive v2 interview rewriting restricted to the trailing marker message.
2. The v2 host prompt path carries no `agent` field; if v2 ever needs a
   specific agent for a plugin-initiated prompt, it must call
   `session.switchAgent` first (as `src/v2/interview-bridge.ts` already does)
   — `withAgent` cannot help there.

---

Regression coverage lives in `src/utils/prompt-agent.test.ts` (unit tests plus
the repo-wide agent-less-prompt scan), `src/interview/runtime.test.ts`,
`src/tools/smartfetch/secondary-model.test.ts`,
`src/interview/finalization.test.ts`, and `src/v2/interview-bridge.test.ts`.
