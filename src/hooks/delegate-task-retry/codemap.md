# src/hooks/delegate-task-retry/

## Responsibility

- Detect delegate tool argument failures after execution and append structured, actionable retry guidance directly into string outputs so the model can recover in-place.

## Design

- `patterns.ts` defines the declarative error contract:
  - `DelegateTaskErrorPattern` (`pattern`, `errorType`, `fixHint`)
  - `DELEGATE_TASK_ERROR_PATTERNS`
  - `detectDelegateTaskError(output: string): DetectedError | null`
- `guidance.ts` implements `buildRetryGuidance(errorInfo)` and `extractAvailableList` to render fix text with optional `Available:` details from tool output.
- `hook.ts` implements `createDelegateTaskRetryHook`:
  - targets only the built-in `task` tool.
  - only mutates when `output.output` is string.
  - detects errors via `detectDelegateTaskError` and appends guidance once.
- `index.ts` is a strict re-export boundary.

## Flow

1. At `tool.execute.after`, confirm tool is `task`.
2. Verify output payload type is string.
3. Quick-scan for generic error indicators (`[ERROR]`, `Invalid arguments`, `is not allowed...`).
4. Match each configured `DELEGATE_TASK_ERROR_PATTERNS` substring in output.
5. Resolve `DetectedError` and append `\n` + `buildRetryGuidance(...)`.

## Integration

- Registered via `src/hooks/index.ts` as a `tool.execute.after` hook for tool-call outputs.
- No dependencies on scheduling/backends (`task` execution itself is delegated to OpenCode core), limiting blast radius.
- Input/output compatibility is limited to OpenCode hook payload shape (`{ tool, output }`) and string-based error diagnostics.
- Primarily consumed by `src/index.ts` where delegation robustness is needed for orchestrator tool usage.
