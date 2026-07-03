# src/hooks/phase-reminder/

## Responsibility
Orchestrates phase reminder injection into user messages for the orchestrator agent, ensuring workflow guidance is appended without mutating the original message content or affecting UI display.

## Design

### Core Abstraction
- **Hook Factory**: `createPhaseReminderHook()` returns an OpenCode experimental chat message transformer hook
- **Non-Mutating Strategy**: Appends phase reminder as a separate message part rather than modifying user-authored text
- **Targeted Injection**: Only processes messages from the orchestrator agent

### Key Components
- `PHASE_REMINDER` constant (imported from `../../config/constants`)
- `SLIM_INTERNAL_INITIATOR_MARKER` constant (imported from `../../utils`)
- Message part type checking and injection logic

### Design Patterns
- **Observer Pattern**: Intercepts and transforms messages before API transmission without altering source
- **Guard Clauses**: Multiple preconditions prevent unnecessary processing:
  - Empty message check
  - User message existence check
  - Orchestrator agent check
  - Duplicate injection prevention
  - Internal initiator marker check

## Flow

1. **Hook Invocation**: OpenCode calls the `experimental.chat.messages.transform` hook before sending messages to API
2. **Message Analysis**: Iterates backward through messages to find the last user message
3. **Agent Validation**: Confirms the message is from the orchestrator agent
4. **Text Part Detection**: Locates the text part in the message
5. **Duplicate Prevention**: Checks for existing phase reminder injection
6. **Injection**: Appends phase reminder as a new text message part
7. **Transmission**: Messages proceed to API with injected reminder (not visible in UI)

## Integration

### Dependencies
- **Config**: `PHASE_REMINDER` constant from `../../config/constants`
- **Utils**: `SLIM_INTERNAL_INITIATOR_MARKER` from `../../utils`
- **Types**: `MessageWithParts` type from `../types`

### Consumers
- **OpenCode**: Registers the hook via plugin initialization
- **Orchestrator Agent**: Receives phase reminders in messages
- **API Layer**: Receives messages with injected reminders (UI remains unaffected)

### Context
- **Execution Timing**: Runs right before API transmission (post-UI rendering)
- **Scope**: Only affects orchestrator agent messages
- **Persistence**: Reminder is appended as a separate message part, preserving original content
