# src/hooks/reflect/

## Responsibility
Implements a reflection hook that enables OpenCode to analyze repeated workflow patterns and suggest reusable improvements. This hook provides a `/reflect` command that generates contextual prompts for reviewing recent work and identifying workflow friction points worth improving.

## Design

### Core Components
- **Command Registration**: Dynamically registers the `reflect` command in OpenCode's configuration system
- **Activation Prompt Generation**: Creates context-aware reflection prompts based on user-provided focus areas
- **Command Interception**: Intercepts command execution to replace default behavior with reflection-focused output

### Architecture Pattern
- **Hook Pattern**: Follows OpenCode's hook system for extending plugin functionality
- **Template Method Pattern**: Uses command templates with dynamic content generation
- **Observer Pattern**: Reacts to command execution lifecycle events

## Flow

### Command Registration Flow
1. Plugin initialization calls `registerCommand()` with OpenCode configuration
2. Checks if `reflect` command already exists in config
3. If not, registers the command with:
   - Template: "Review repeated work and suggest workflow improvements"
   - Description: "Use reflect to learn from repeated workflows and suggest reusable improvements"
4. Sets `shouldHandleCommand` flag to enable command handling

### Command Execution Flow
1. User invokes `/reflect` command with optional arguments
2. `handleCommandExecuteBefore()` hook intercepts the execution
3. Clears existing output parts
4. Generates activation prompt using `activationPrompt()` helper:
   - If focus argument provided: uses it as primary focus
   - If no focus: provides default focus about reviewing work broadly
   - Includes reflection requirements and evidence-based recommendations
5. Replaces output with the generated reflection prompt

### Prompt Generation Logic
```typescript
function activationPrompt(focus: string): string {
  const focusBlock = focus
    ? ['Focus:', focus]
    : [
        'Focus:',
        'Review recent work broadly and identify repeated workflow friction worth improving.',
      ];

  return [
    'Use the reflect skill for this request.',
    '',
    'Reflect requirements:',
    '- inspect existing skills, commands, agents, prompt overrides, MCP permissions, config, and project playbooks before suggesting anything new;',
    '- find repeated workflow patterns from the current conversation, project notes, local memories, logs, or session artifacts that are available and safe to inspect;',
    '- prefer evidence from repeated recent behavior over speculation;',
    '- recommend the smallest useful improvement: prompt/config rule, skill, command, custom agent, MCP/tool permission change, project playbook, or skip;',
    '- treat creating nothing as a valid result when evidence is weak;',
    '- ask before changing prompts, skills, commands, agents, MCP access, or config unless the user explicitly requested the exact edit;',
    '- return a compact report with findings, recommended changes, skipped candidates, and items needing more evidence.',
    '',
    ...focusBlock,
  ].join('\n');
}
```

## Integration

### Dependencies
- **OpenCode Plugin System**: Uses `registerCommand` and `handleCommandExecuteBefore` hook interfaces
- **Configuration System**: Reads and writes to OpenCode configuration object
- **Command Lifecycle**: Integrates with OpenCode's command execution pipeline


### Consumers
- **OpenCode Core**: Consumed by OpenCode's plugin system during initialization
- **Users**: Invoked via `/reflect` command in OpenCode sessions

### Integration Points
- `registerCommand()`: Called during plugin initialization to register the reflect command
- `handleCommandExecuteBefore()`: Hook that intercepts command execution and transforms output
- OpenCode configuration object: Receives the registered command configuration

### Configuration Schema
```json
{
  "command": {
    "reflect": {
      "template": "Review repeated work and suggest workflow improvements",
      "description": "Use reflect to learn from repeated workflows and suggest reusable improvements"
    }
  }
}
```

## Usage Examples

### Basic Usage
```
/reflect
```
Generates a default reflection prompt focused on reviewing recent work broadly.

### Focused Reflection
```
/reflect Focus: Improve test coverage workflow
```
Generates a reflection prompt focused specifically on test coverage workflow improvements.

### Workflow Analysis
The hook helps identify:
- Repeated manual steps in workflows
- Configuration duplication across projects
- Permission or MCP access patterns that could be streamlined
- Prompt templates that could be generalized into skills
- Commands that could be automated or combined
