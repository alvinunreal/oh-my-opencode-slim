# Council Module Codemap

## Responsibility

`src/council/` orchestrates parallel/serial multi-LLM council sessions and produces
normalized councillor results for the `council` agent to synthesize.

It is intentionally execution-focused:

- validate council configuration + preset selection,
- launch and monitor councillor sub-sessions,
- normalize outputs + retry behavior,
- return a structured result object to the caller tool.

Prompt templates and tool schemas are defined in `agents/` and `tools/`.

## Architecture

- `council-manager.ts` is the core engine.
- `index.ts` is the module barrel.

### council-manager responsibilities

- Reads injected plugin context (`PluginInput`) and optional:
  - config (`PluginConfig`),
  - `SubagentDepthTracker`,
  - `tmuxEnabled` flag for pane launch pacing.
- Owns runtime helpers:
  - `runCouncil()` orchestration entry,
  - `runCouncillors()` fan-out strategy,
  - `runCouncillorWithRetry()` and `runAgentSession()` for per-councillor lifecycle.
- Uses shared session utilities from `utils/session.ts`:
  - `parseModelReference` for model string validation,
  - `promptWithTimeout` for bounded prompt calls,
  - `extractSessionResult` to collect assistant text,
  - `shortModelLabel` for UI-friendly model names.
- Delegates prompt/result shaping to `formatCouncillorPrompt` and
  `formatCouncillorResults` in `agents/council.ts`.

## Runtime flow

```text
runCouncil(prompt, presetName?, parentSessionId)
  ├─> enforce max depth with SubagentDepthTracker
  ├─> load council config from plugin config
  ├─> resolve preset (fallback: default_preset -> "default")
  ├─> fail fast when preset missing or empty
  ├─> emit start notification to parent session (best-effort, non-blocking)
  ├─> resolve runtime policy
  │     timeout, execution mode, retry budget
  ├─> run councillors in selected mode
  │     - runAgentSession: create -> register depth -> optional tmux delay
  │       -> prompt -> extract text -> session abort in finally
  │     - runCouncillorWithRetry: retries only "Empty response from provider"
  │       up to `councillor_retries`
  │     - parallel mode uses indexed staggering to reduce pane launch collisions
  ├─> aggregate results with per-councillor status
  ├─> if no completed councillors: return failure result
  └─> format and return results for caller synthesis
```

## Error and result model

- Each councillor returns status:
  - `completed` with `result` text,
  - `failed` with `error`,
  - `timed_out` with timeout message.
- Empty provider responses are treated as failures unless failover retry-on-empty is disabled
  via `fallback.retry_on_empty`.
- A single councillor's malformed model string is surfaced as failure for that councillor; the
  session still proceeds with the remaining councillors.
- Depth limit violations return a hard failure (`Subagent depth exceeded`) without starting
  any councillor session.

## Configuration semantics (delegated to schema)

Validated in `config/council-schema.ts` and consumed in `runCouncil`:

- `presets` with per-preset councillor definitions,
- `default_preset`,
- `timeout`,
- `councillor_execution_mode` (`parallel`/`serial`),
- `councillor_retries`.

Legacy schema behavior:

- nested legacy `councillors` keys are unwrapped,
- top-level `master` key is ignored at preset level,
- deprecated `master` fields are recorded (via `_deprecated`) and surfaced to the caller
  as warnings, while `_legacyMasterModel` is kept for fallback messaging.

## Integration points

- **Tool caller:** `tools/council.ts` creates `council_session` and calls
  `runCouncil(prompt, preset, parentSessionId)`.
- **Plugin init:** `src/index.ts` constructs `CouncilManager` with runtime config,
  `SubagentDepthTracker`, and multiplexer capability before exposing `council_session`.
- **Depth lifecycle:** `SubagentDepthTracker` is also used in plugin event hooks to register/
  cleanup child sessions as they are created/deleted.
- **Runtime constants:** `config/constants.ts` provides launch delays (`TMUX_SPAWN_DELAY_MS`,
  `COUNCILLOR_STAGGER_MS`) used to avoid multiplexer collision.
