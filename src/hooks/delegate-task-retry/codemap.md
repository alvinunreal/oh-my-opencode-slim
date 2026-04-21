# src/hooks/delegate-task-retry/

## Responsibility

Adds targeted recovery guidance for failed delegation (`task`) calls by analyzing
tool output and appending a concise retry hint that preserves the existing model
conversation context.

## Design

- `index.ts` re-exports:
  - `createDelegateTaskRetryHook`
  - `buildRetryGuidance`
  - pattern types/helpers
- `patterns.ts` defines the typed `DelegateTaskErrorPattern` contract and ordered
  detection catalog (`DELEGATE_TASK_ERROR_PATTERNS`).
- `detectDelegateTaskError(output)`:
  1. ensures string output,
  2. requires one of generic error indicators,
  3. returns the first matching configured error pattern.
- `buildRetryGuidance(errorInfo)` maps each match to user-facing fix text,
  optionally appending `Available:` suggestions parsed from tool output.
- `hook.ts` returns a `tool.execute.after` handler and mutates only string
  outputs.

## Flow

1. OpenCode invokes the handler with `{ tool, output }` after `task` execution.
2. The hook ignores non-`task` tools and non-string outputs.
3. If output passes generic error signal checks, `detectDelegateTaskError` scans
   configured patterns.
4. On match, inline guidance is appended to `output.output` with correction
   guidance and example `task(...)` usage.
5. No additional API calls are made; behavior is synchronous string-level
   recovery.

## Integration

- Registered in `src/index.ts` under `tool.execute.after`.
- Input payload expectations are minimal (`{ tool: string }` + `{ output: unknown }`)
  to stay aligned with tool-callback shape and avoid side-effecting unrelated
  callbacks.
- This hook remains independent of orchestration engines and multiplexer/session
  managers.
