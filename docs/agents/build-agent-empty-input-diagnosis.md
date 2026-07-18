# Diagnosis: "build agent empty input" after orchestrator output

**Status:** Diagnosis only — no code change yet.
**Date:** 2026-07-19
**Related PR:** #818 (`fix/preset-tui-slash-command`) — same root class as the original `/preset` fix.
**Suspected sibling bug reported by user:** During `superpowers` / `brainstorm` skill conversations, when the orchestrator asks for confirmation or work is interrupted (subagent completes, background task finishes), a `build` agent turn sometimes appears with an empty user input.

## TL;DR

The `build` agent turn with empty input is **the same class of bug** as the original `/preset` issue fixed in #818: a plugin hook calls `sessionSdk.promptAsync({ body: { parts: [createInternalAgentTextPart(...)] } })` **without specifying an `agent` field**. opencode then resolves the agent via `agents.defaultInfo()`, which falls back to the built-in `build` agent whenever `default_agent` is unset, user-overridden, or not effectively applied. The `synthetic: true` flag hides the injected text from the TUI, so the user perceives the `build` turn as having "empty input."

## Root cause (causal chain, cross-validated)

1. **Orchestrator enters input-wait.** After emitting a confirmation question (skill flow), the assistant turn finishes. opencode's per-session Runner transitions to `Idle` (`packages/opencode/src/effect/runner.ts:115-138`, `packages/opencode/src/session/run-state.ts:60-63`). The session is no longer "busy" from the Runner's perspective.

2. **Plugin hook fires `promptAsync` with a synthetic part and no `agent` field.** Two call sites in omos do this:
   - `src/hooks/task-session-manager/index.ts:398-402` — `CONTINUATION_NUDGE` injection, fires on `session.idle` / `session.status(idle)` when the orchestrator session has incomplete todos (matches "subagent completes" / "background task finishes").
   - `src/interview/service.ts:622, 871, 933, 1007` — interview/skill flow injections (matches "brainstorm skill flow").

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
| `src/hooks/task-session-manager/index.ts:398-402` | `session.idle` / `session.status(idle)` on orchestrator session with incomplete todos | **Yes** | `continuationConsumed`, `hasInputWait` (3×: lines 282, 362, 386), `isCurrentContinuation`, `isFallbackInProgress`, `backgroundJobBoard.hasTerminalUnreconciled` |
| `src/interview/service.ts:622` | User submits interview dashboard input | **Yes** | `sessionBusy` lock, interview active state |
| `src/interview/service.ts:871` | User submits interview chat | **Yes** | same |
| `src/interview/service.ts:933` | User submits interview answer | **Yes** | same |
| `src/interview/service.ts:1007` | User submits interview comment | **Yes** | same |
| `src/interview/service.ts:504` | Interview URL notification | **Yes** (but `noReply: true`, non-synthetic text) | none |
| `src/tools/smartfetch/secondary-model.ts:252` | Smartfetch secondary model query | **Yes** | none |

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

The gate exists and works in the common case (`task-session-manager/index.ts:282, 362, 386`, with tests at `index.test.ts:2772-2858, 3013-3048`). But:

1. **Documented race window.** `IDLE_RECONCILE_DELAY_MS = 2_000` (line 54). The comment at lines 49-53 admits: "Completions arriving after the window are still dropped (the race is reduced, not eliminated)." If `session.idle` fires and the 2s timer expires before `question.asked` is delivered, and the 3 SDK calls (`todo`/`children`/`status`) in `evaluateContinuation` all resolve before `question.asked` arrives, the nudge fires.

2. **Input-wait is not the only trigger.** The interview/skill path (`src/interview/service.ts`) does **not** consult `hasInputWait` at all — it injects on user dashboard actions, which can happen while the orchestrator is mid-question.

3. **The gate does not address the missing `agent` field.** Even when the nudge legitimately fires (no input-wait, real incomplete todos), the resulting turn still routes to `build` if `default_agent` is unset. The gate prevents *some* unwanted injections; it does not prevent *misrouting* when injection happens.

## Why this is the same class as the #818 `/preset` fix

#818's original bug: `/preset` used `createInternalAgentTextPart()` to trigger an LLM turn that was invisible in the TUI (`synthetic: true`). The fix moved `/preset` to pure TUI dialogs (`src/tui-preset.ts` uses only `api.ui.dialog` / `DialogSelect` / `DialogPrompt` / `DialogConfirm` — no `promptAsync`).

This bug: other hooks still use the same `createInternalAgentTextPart` + `promptAsync` pattern, and additionally omit the `agent` field, so the invisible turn routes to `build` instead of the orchestrator. Same shape: a synthetic part starting an invisible turn. Different symptom: `build` agent instead of orchestrator.

## Fix directions (not implemented — awaiting decision)

### Minimal fix
Add `agent: 'orchestrator'` to the `promptAsync` body at all four affected call sites:
- `src/hooks/task-session-manager/index.ts:398-402`
- `src/interview/service.ts:622, 871, 933, 1007`

This ensures the continuation nudge and interview injections always route to the orchestrator regardless of opencode's `default_agent` resolution, eliminating the path to `build`.

### Hardening (optional, larger scope)
1. **Input-wait guard on the interview/skill path.** Consult `hasInputWait` (or an equivalent signal) before injecting in `src/interview/service.ts`. Do not inject while the orchestrator is waiting for user input.
2. **Post-injection agent assertion.** After each `promptAsync`, assert `current.agent` was not changed out from under the orchestrator; if it was, restore it via `setAgentModel`.
3. **Investigate the `default_agent` application reliability** on opencode v1.18.x. The plugin was built against `@opencode-ai/sdk` v1.4.3; the installed runtime is v1.18.3. The `config` hook's `default_agent = 'orchestrator'` mutation may not be applied reliably under this skew. (Note: #799 tracks the package upgrade.)
4. **Shrink or eliminate the `IDLE_RECONCILE_DELAY_MS` race** for sessions that have a pending `question.asked` / `permission.asked`.

## Evidence index

### omos source
- **Missing `agent` field (the bug):** `src/hooks/task-session-manager/index.ts:398-402`
- **Missing `agent` field (skill flow):** `src/interview/service.ts:622, 871, 933, 1007`
- **Correct pattern for comparison:** `src/hooks/foreground-fallback/index.ts:635-639`
- **omos sets `default_agent` only when absent:** `src/index.ts:546-551`
- **`createInternalAgentTextPart` produces `synthetic: true`:** `src/utils/internal-initiator.ts:9-21`
- **`CONTINUATION_NUDGE` is non-empty:** `src/hooks/task-session-manager/index.ts:56-57`
- **`hasInputWait` gate (3 checks):** `src/hooks/task-session-manager/index.ts:282, 362, 386`
- **`IDLE_RECONCILE_DELAY_MS` race window:** `src/hooks/task-session-manager/index.ts:54` (admission at lines 49-53)
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

## Open questions for the fix

1. Should the fix be a new PR, or amended into #818? (#818 is currently `MERGEABLE` / `CLEAN` / CI green; amending widens its scope and may delay merge.)
2. Is the interview/skill path expected to always route to the orchestrator, or could it intentionally target a different agent in some flows?
3. Should we also harden the `default_agent` application (fix direction #3) as part of this work, or track it separately under #799?

---

This report is diagnostic only. No code was changed. The fix awaits the user's decision on scope and PR strategy.
