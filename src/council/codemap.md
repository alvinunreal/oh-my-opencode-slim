# Council Module Codemap

## Responsibility

`src/council/` executes multi-LLM consensus sessions.

It owns council orchestration and result normalization, while the actual `council` agent remains in `agents/council.ts`.

## Architecture

- `council.ts` is a barrel that exports `CouncilManager`.
- `council-manager.ts` is the engine:
  - validates preset selection and depth constraints
  - launches councillor sessions
  - retries on empty provider responses
  - formats outputs for synthesis by caller tool

## Runtime flow

```text
runCouncil(prompt, preset, parentSessionId)
  ├─> enforce depth via SubagentDepthTracker
  ├─> load council config
  ├─> resolve preset (default if absent)
  ├─> run all councillors in parallel or serial mode
  │     - each councillor session: create -> prompt -> extract -> abort
  │     - tmux delay + stagger delay for launch collisions
  │     - retry on empty response up to configured retry count
  ├─> if none completed -> error
  └─> formatCouncillorResults(prompt, completed responses)
```

Execution characteristics:

- Uses `councillor` agent internally (`agent: 'councillor'`), `tools.task: false`.
- Timeout is passed per session.
- Empty results are treated as failures unless global fallback policy disables empty-retry behavior.
- Failed/timed out results are still returned as structured metadata (`name`, `model`, `status`, `error`).
- On start, writes a non-blocking session note to parent session via `session.prompt`.

### Configuration semantics

- Preset schema in `config/council-schema.ts`:
  - per-preset named councillors
  - `default_preset`
  - `timeout`
  - `councillor_execution_mode` (`parallel`/`serial`)
  - `councillor_retries`
- Deprecated master fields are accepted in schema, ignored, and surfaced as runtime warnings through `getDeprecatedFields()`.

## Integration

- `tools/council.ts` defines `council_session` and is the only caller that invokes `CouncilManager.runCouncil(...)`.
- Integrates with:
  - `config` (for preset/timeouts/retry policy)
  - `SubagentDepthTracker` (to prevent nested delegation explosions)
  - session client (`client.session.*`) for sub-session lifecycle
  - `multiplexer` settings (tmux launch delay behavior)
