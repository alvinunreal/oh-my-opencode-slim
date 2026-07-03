# src/hooks/deepwork/

## Responsibility

Provides an OpenCode hook implementation for managing deepwork sessions — heavy, multi-phase coding tasks that require structured planning, phased execution, and continuous validation.

This hook enables developers to:
- Initiate deepwork sessions via `/deepwork <task>` command
- Maintain `.slim/deepwork/` progress tracking files
- Keep OpenCode todos synchronized with current phase
- Enforce phased implementation with `@oracle` review gates
- Execute phases with background specialist agents where appropriate
- Validate results and incorporate simplification/readability feedback

## Design

### Core Abstraction
The hook follows the OpenCode plugin hook pattern, exposing a factory function `createDeepworkCommandHook()` that returns an object with two methods:

- `registerCommand(config)`: Registers the `deepwork` command in OpenCode configuration
- `handleCommandExecuteBefore(input, output)`: Intercepts command execution to inject the deepwork activation prompt

### State Management
- Uses OpenCode's internal agent text part system (`createInternalAgentTextPart`) for output
- Clears existing output parts before injecting deepwork prompt
- Validates task presence before activation

### Integration Points
- Consumes OpenCode session context (`sessionID`)
- Integrates with OpenCode command system via `command` configuration
- Leverages `@oracle` for review and simplification feedback
- Supports background specialist agents (`@fixer`, `@explorer`, etc.) for phase execution

## Flow

### Command Registration Phase
1. Plugin initialization calls `registerCommand()` with OpenCode configuration
2. Checks if `deepwork` command already registered
3. If not, adds command configuration:
   - Template: "Start a deepwork session for a complex coding task"
   - Description: "Use the deepwork workflow for heavy multi-phase coding work"

### Command Execution Phase
1. User invokes `/deepwork <task>` command
2. OpenCode triggers `handleCommandExecuteBefore()` hook
3. Hook validates command name (`deepwork`)
4. If no task provided:
   - Outputs error message via `createInternalAgentTextPart()`
   - Prompts user: "What task should deepwork manage? Run `/deepwork <task>`."
5. If task provided:
   - Clears existing output parts (`output.parts.length = 0`)
   - Generates activation prompt via `activationPrompt(task)`
   - Injects activation prompt into output parts
   - Prompt instructs agents to use deepwork skill with specific requirements

### Deepwork Session Execution
1. Agent receives activation prompt with task description
2. Agent creates `.slim/deepwork/` progress file
3. Agent maintains OpenCode todo synchronization
4. Agent drafts plan and requests `@oracle` review
5. Agent creates and reviews phased implementation/delegation plan
6. Agent executes phases with background specialists as needed
7. Agent waits for hook-driven background completion
8. Agent reconciles results and validates
9. Agent requests `@oracle` review for each phase
10. Agent incorporates simplification/readability feedback
11. Agent fixes actionable review issues before continuing

## Integration

### Consumers
- **Main plugin** (`src/index.ts`): Registers the deepwork hook during plugin initialization
- **OpenCode CLI**: Invokes hook when `/deepwork` command is executed
- **Agents** (`@oracle`, `@fixer`, `@explorer`, etc.): Follow deepwork workflow for complex tasks

### Dependencies
- **OpenCode SDK**: Provides `createInternalAgentTextPart` utility and hook interface
- **Configuration system**: Reads from `opencodeConfig.command` structure
- **Session system**: Receives `sessionID` for context tracking
- **Agent ecosystem**: Leverages specialist agents for phase execution


### Configuration Schema
```json
{
  "command": {
    "deepwork": {
      "template": "Start a deepwork session for a complex coding task",
      "description": "Use the deepwork workflow for heavy multi-phase coding work"
    }
  }
}
```

### File System
- Creates progress tracking: `.slim/deepwork/<session-id>/` directory and files
- Maintains synchronization with OpenCode todos


### Hook Contract
- **Input**: `{ command: string, sessionID: string, arguments: string }`
- **Output**: `{ parts: Array<{ type: string, text?: string }> }`
- **Side effects**: Modifies output parts array, may create progress files
- **Validation**: Validates task presence, validates command name
