# src/hooks/deepwork/

## Responsibility

Provides an OpenCode hook implementation for managing deepwork sessions - heavy, multi-phase coding tasks that require structured planning, phased execution, and continuous validation.

This hook enables developers to:
- Initiate deepwork sessions via `/deepwork <task>` command
- Maintain `.slim/deepwork/` progress tracking files
- Run pass-by-pass work (sketch → structure → detail) with one `@oracle` gate per pass
- Execute passes with background specialist agents where appropriate
- Step back between passes to re-plan and reorganize code

## Design

### Core Abstraction
The hook follows the OpenCode plugin hook pattern, exposing a factory function `createDeepworkCommandHook()` that returns an object with two methods:

- `registerCommand(config)`: Registers the `deepwork` command in OpenCode configuration
- `handleCommandExecuteBefore(input, output)`: Intercepts command execution to inject the deepwork activation prompt

### State Management
- Uses OpenCode's internal agent text part system (`createInternalAgentTextPart`) for output
- Replaces activation text while retaining non-text attachments
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
    - Replaces activation text while retaining attachments
   - Generates activation prompt via `activationPrompt(task, sessionID)`
   - Injects activation prompt into output parts
   - Prompt = bundled SKILL.md body (single contract source, build-time text
     import) + pinned router-head path + task

### Deepwork Session Execution
1. Agent receives the full workflow instructions (SKILL.md body) with the pinned router-head path and task
2. Agent creates its `.slim/deepwork/<session-id>.md` router head (`status:` + `slug:`) and the task directory it points to
3. Agent works in passes over the whole product (sketch → structure → detail), each with a one-line goal and a few disjoint lanes
4. One `@oracle` design review of the pass plan covers risky lanes before code; lanes report files, commands, and exit codes
5. Each pass ends with broad validation, one `@oracle` gate scoped to that pass, a commit, and a step back (re-plan, reorganize code if needed)
6. Runs autonomously to the end; asks only when truly blocked
7. Completion rewrites the progress file into a `status: completed` tombstone listing remaining known issues

## Integration Points
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
    - Replaces activation text while retaining attachments
   - Generates activation prompt via `activationPrompt(task, sessionID)`
   - Injects activation prompt into output parts
   - Prompt = bundled SKILL.md body (single contract source, build-time text
     import) + pinned router-head path + task

### Deepwork Session Execution
1. Agent receives the full workflow instructions (SKILL.md body) with the pinned router-head path and task
2. Agent creates its `.slim/deepwork/<session-id>.md` router head and the task directory it points to
3. Agent drafts plan and requests `@oracle` review
4. Agent creates and reviews phased implementation/delegation plan
5. Agent executes phases with background specialists as needed
6. Agent waits for hook-driven background completion
7. Agent reconciles results and validates
8. Agent requests `@oracle` review for each phase
9. Agent incorporates simplification/readability feedback
10. Agent fixes actionable review issues before continuing

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
- Router head: `.slim/deepwork/<session-id>.md`, path pinned by the activation prompt; task state lives in `.slim/deepwork/<task-slug>/progress.md`


### Hook Contract
- **Input**: `{ command: string, sessionID: string, arguments: string }`
- **Output**: `{ parts: Array<{ type: string, text?: string }> }`
- **Side effects**: Modifies output parts array
- **Validation**: Validates task presence, validates command name
