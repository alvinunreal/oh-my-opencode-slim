# src/hooks/loop-command/

## Responsibility

Implements the `/loop` runtime command as a thin user-entry adapter that
directs the parent/orchestrator to load the `loop-engineering` skill as the
bounded delivery protocol for a prepared delivery unit. The hook preserves
supplied user context and any stricter user attempt limit, and states the
canonical delivery handoff contract. It does not run an execute-verify-retry
loop itself; the parent coordinates the protocol.

## Design

### Core Architecture
- **`createLoopCommandHook()`** — produces a command hook that registers `/loop`
  with `registerCommandHook` from `command-hook-utils`, and intercepts
  `command.execute.before` to rewrite the output.
- **Adapter payload** — the activation prompt declares `/loop` is a user-entry
  adapter, points the parent at the `loop-engineering` protocol, requires a
  prepared unit/specification and proof contract, and explicitly prohibits
  `.opencode/loop-history/`, treating a pass as initiative completion,
  resettable attempt budgets, and invoking `/loop` as a callable subprocedure.
- **Shared handoff contract** — `DELIVERY_HANDOFF_CONTRACT` from
  `command-hook-utils` is embedded in the activation prompt so the delivery
  unit packet shape and delivery order travel with the handoff.
- **Safety defaults** — if the user omits arguments, the hook emits adapter
  help text instead of activating.

## Flow

### `/loop` activation
```
1. User types `/loop <description>`
2. OpenCode invokes command.execute.before for 'loop'
3. Hook clears output and injects the adapter activation prompt
4. Parent/orchestrator loads loop-engineering and coordinates the protocol
```

## Integration

### Consumers
- **Command Registration Utility** (`src/hooks/command-hook-utils.ts`) — provides `registerCommandHook` and `DELIVERY_HANDOFF_CONTRACT`
- **OpenCode runtime** — `command.execute.before` interception
- **Parent/orchestrator** — owns protocol coordination after handoff

### Dependencies
- `src/utils/internal-initiator.ts` — `createInternalAgentTextPart`
- `src/hooks/command-hook-utils.ts` — command registration helper and shared handoff contract

## Testing

- `src/hooks/loop-command/index.test.ts`
