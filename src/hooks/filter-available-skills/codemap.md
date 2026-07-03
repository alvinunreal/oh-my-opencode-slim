# src/hooks/filter-available-skills/

## Responsibility

Implements the skill filtering hook that dynamically filters the `<available_skills>` block in chat messages based on the current agent's permission rules. This ensures agents only see skills they're authorized to use.

## Design

The hook is implemented as an `experimental.chat.messages.transform` hook that runs just before messages are sent to the API. It does not affect UI display.

### Core Components:

- **SkillEntry**: Represents a single skill with name and XML block
- **SkillRule**: Permission types ('allow', 'ask', 'deny')
- **Permission Rules Cache**: Maps agent names to their skill permission rules for performance

### Permission Resolution Flow:

1. **Agent Detection**: Extracts current agent name from message history (defaults to 'orchestrator')
2. **Permission Lookup**: Retrieves skill rules for the agent from configuration
3. **Block Extraction**: Uses regex to parse `<skill>` blocks from `<available_skills>` XML
4. **Filtering**: Applies permission rules to each skill entry
5. **Reconstruction**: Rebuilds the `<available_skills>` block with only allowed skills

### Key Functions:

- `getCurrentAgent()`: Extracts agent name from message metadata
- `extractSkillEntries()`: Parses XML skill blocks using regex
- `isSkillAllowed()`: Evaluates permission rules for a skill
- `filterAvailableSkillsText()`: Main filtering logic that rewrites the XML block
- `createFilterAvailableSkillsHook()`: Factory that creates the hook instance

## Flow

```
Message Preparation → Hook Execution → Message Transformation → API Send
                     ↓
            filterAvailableSkillsText()
                     ↓
            Extract skill entries from <available_skills>
                     ↓
            Check each skill against permission rules
                     ↓
            Rebuild XML block with allowed skills only
```

### Detailed Execution Sequence:

1. **Hook Creation** (`createFilterAvailableSkillsHook`):
   - Called during plugin initialization
   - Creates a permission rules cache per agent
   - Returns the hook function

2. **Hook Execution** (`experimental.chat.messages.transform`):
   - Triggered before each message batch is sent to API
   - Receives the message array with parts
   - Identifies current agent from message metadata
   - Retrieves cached permission rules for that agent

3. **Skill Filtering** (`filterAvailableSkillsText`):
   - Scans each message part for `<available_skills>` XML
   - Extracts individual `<skill>` blocks using regex
   - For each skill, checks permission rules:
     - Specific skill rule takes precedence
     - Wildcard rule ('*') applies as fallback
   - Reconstructs XML block with only allowed skills
   - Returns "No skills available." if all skills are filtered out

4. **Result**:
   - Modified messages are sent to API with filtered skill list
   - UI remains unchanged (filtering happens server-side)

## Integration

### Consumed By:
- **Main Plugin**: Integrated via `src/index.ts` plugin initialization
- **Configuration System**: Depends on `src/config/` for agent overrides and skill permissions
- **CLI**: Uses `src/cli/skills.ts` for default skill permission definitions


### Dependencies:
- **@opencode-ai/plugin**: Plugin input/output types
- **src/config/**: Plugin configuration and agent overrides
- **src/cli/skills.ts**: Default skill permission rules
- **OpenCode Core**: Injects `<available_skills>` block globally in messages

### Integration Points:
- **Message Pipeline**: Hooks into `experimental.chat.messages.transform` lifecycle
- **Permission System**: Works with `disabled_skills` and agent-specific skill configurations
- **Agent Context**: Dynamically adapts to current agent based on message history


### Configuration Schema:
- **Agent Overrides**: Skills can be customized per agent in configuration
- **Disabled Skills**: Global skill blacklist via `disabled_skills` config
- **Permission Rules**: Skill-specific rules override wildcard rules

### Example Usage Flow:

```
User Message → Agent Selection → Skill Filtering → API Request → Response
                     ↓
            filterAvailableSkillsHook runs
                     ↓
            Only authorized skills visible to agent
```

## Performance Considerations

- Permission rules are cached per agent to avoid repeated configuration lookups
- Regex-based parsing is efficient for the relatively small `<available_skills>` block
- Hook runs only once per message batch, not per message
- No impact on UI rendering performance
