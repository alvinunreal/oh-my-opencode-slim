# src/hooks/deepwork/

## Responsibility

Provides the `/deepwork` runtime command as a thin user-entry adapter that
directs the parent/orchestrator to load the deepwork protocol for either
long-horizon coordination or a Tier-2 initiative. The hook preserves supplied
user context, states the canonical delivery handoff contract, and explicitly
prohibits `.slim/deepwork/`, per-phase Oracle gates, and a separate retry
controller. The parent coordinates the protocol; the slash command does not.

## Design

### Core Abstraction
The hook follows the OpenCode plugin hook pattern, exposing a factory function `createDeepworkCommandHook()` that returns an object with two methods:

- `registerCommand(config)`: Registers the `deepwork` command in OpenCode configuration
- `handleCommandExecuteBefore(input, output)`: Intercepts command execution to inject the deepwork adapter activation prompt

### State Management
- Uses OpenCode's internal agent text part system (`createInternalAgentTextPart`) for the no-argument help output
- Clears existing output parts before injecting the activation prompt
- Validates task presence before activation

### Integration Points
- Consumes OpenCode session context (`sessionID`)
- Integrates with OpenCode command system via `command` configuration
- Embeds `DELIVERY_HANDOFF_CONTRACT` from `command-hook-utils` so the delivery unit packet shape and delivery order travel with the handoff

## Flow

### Command Registration Phase
1. Plugin initialization calls `registerCommand()` with OpenCode configuration
2. Checks if `deepwork` command already registered
3. If not, adds command configuration:
   - Template: "Coordinate a deepwork initiative for consequential or long-horizon work"
   - Description: "User-entry adapter for the canonical deepwork Tier-2 coordination protocol."

### Command Execution Phase
1. User invokes `/deepwork <task>` command
2. OpenCode triggers `handleCommandExecuteBefore()` hook
3. Hook validates command name (`deepwork`)
4. If no task provided:
   - Outputs a clarification message via `createInternalAgentTextPart()`
   - Prompts user: "What initiative should deepwork coordinate? Run `/deepwork <initiative>`."
5. If task provided:
   - Clears existing output parts (`output.parts.length = 0`)
   - Generates the adapter activation prompt via `activationPrompt(task)`
   - Injects activation prompt into output parts
   - Prompt directs the parent to load the deepwork protocol, use
     `.slim/plans/<initiative>/` records, and states the prohibitions and
     delivery handoff contract

## Integration

### Consumers
- **Main plugin** (`src/index.ts`): Registers the deepwork hook during plugin initialization
- **OpenCode CLI**: Invokes hook when `/deepwork` command is executed
- **Parent/orchestrator**: Owns protocol coordination after handoff

### Dependencies
- `src/utils/internal-initiator.ts` — `createInternalAgentTextPart`
- `src/hooks/command-hook-utils.ts` — `registerCommandHook` and `DELIVERY_HANDOFF_CONTRACT`

### Configuration Schema
```json
{
  "command": {
    "deepwork": {
      "template": "Coordinate a deepwork initiative for consequential or long-horizon work",
      "description": "User-entry adapter for the canonical deepwork Tier-2 coordination protocol."
    }
  }
}
```

### Hook Contract
- **Input**: `{ command: string, sessionID: string, arguments: string }`
- **Output**: `{ parts: Array<{ type: string, text?: string }> }`
- **Side effects**: Modifies output parts array
- **Validation**: Validates task presence, validates command name

## Testing

- `src/hooks/deepwork/index.test.ts`
