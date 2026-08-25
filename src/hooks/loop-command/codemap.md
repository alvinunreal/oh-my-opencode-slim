# src/hooks/loop-command/

## Responsibility

Implements the `/loop` runtime command as an automated execute-verify-retry loop.
The hook extracts goal, successCriteria, and maxAttempts from the user's command
text, then instructs the agent to iterate with on-disk per-run history under
`.opencode/loop-history/`.

## Design

### Core Architecture
- **`createLoopCommandHook()`** — produces a command hook that registers `/loop`
  with `registerCommandHook` from `command-hook-utils`, and intercepts
  `command.execute.before` to rewrite the output.
- **History directory** — each invocation generates a unique
  `.opencode/loop-history/loop-<timestamp>-<shortid>/` path; the agent writes
  `history-NNN.md` results into that directory.
- **Safety defaults** — if the user omits arguments, the hook emits help text
  instead of activating. Missing or unclear goal/successCriteria/maxAttempts
  causes a clarification push-back prompt.

## Flow

### `/loop` activation
```
1. User types `/loop <description>`
2. OpenCode invokes command.execute.before for 'loop'
3. Hook clears output and injects the structured loop prompt
4. Agent executes per-attempt: read history, dispatch @fixer, verify, write result
5. History persisted to `.opencode/loop-history/`
6. Loop stops on PASS or exits on FAIL after maxAttempts
```

## Integration

### Consumers
- **Command Registration Utility** (`src/hooks/command-hook-utils.ts`) — provides `registerCommandHook`
- **OpenCode runtime** — `command.execute.before` interception
- **Agent workspace** — `.opencode/loop-history/` filesystem for loop history

### Dependencies
- `src/utils/internal-initiator.ts` — `createInternalAgentTextPart`
- `src/hooks/command-hook-utils.ts` — command registration helper

## Testing

- `src/hooks/loop-command/index.test.ts`