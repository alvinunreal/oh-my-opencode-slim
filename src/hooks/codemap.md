# src/hooks/

## Responsibility
Implements OpenCode lifecycle hooks that transform, process, and manage chat messages and attachments during the plugin's message pipeline. These hooks are invoked by OpenCode's `experimental.chat.messages.transform` API to modify message content before it reaches models or after responses are generated.

## Design

### Core Architecture
- **Factory Pattern**: Each hook is created via a factory function (e.g., `createApplyPatchHook()`, `createAutoUpdateCheckerHook()`) that returns a hook function matching the OpenCode hook signature.
- **Stateful Factories**: Hook factories may maintain closure state between invocations (e.g., `createAutoUpdateCheckerHook` guards with `hasChecked`; `createTaskSessionManagerHook` manages session lifecycle). Other hooks remain stateless — each factory decides based on its needs.
- **Message Transformation Pipeline**: Hooks operate on the `MessageWithParts[]` type, allowing transformation of user messages, assistant responses, and system messages.

### Key Types & Interfaces
- `MessageInfo`: Metadata about a message (role, agent, sessionID, id)
- `MessagePart`: Individual content part of a message (text, file, image, tool use, etc.)
- `MessageWithParts`: Complete message with metadata and array of parts

### Hook Categories
1. **Attachment Processing**: `processImageAttachments` - Extracts image data URLs from messages, saves them to `.opencode/images/` directory, and replaces image parts with text references containing file paths.
2. **State Management**: Hooks like `createTaskSessionManagerHook` that manage session state and lifecycle.
3. **Error Recovery**: Hooks like `createJsonErrorRecoveryHook` that detect and recover from JSON parsing errors.
4. **UI/UX Enhancement**: Hooks like `createPhaseReminderHook` that add contextual reminders to messages.
5. **Task Management**: Hooks like `createDelegateTaskRetryHook` that handle task retry logic.

## Flow

### Message Processing Pipeline
```
1. OpenCode receives chat messages
2. Plugin's `experimental.chat.messages.transform` hook is invoked
3. Each registered hook receives the message array sequentially
4. Hooks transform messages (e.g., extract images, add metadata, validate structure)
5. Transformed messages are sent to the model
6. Model responses are transformed by hooks in reverse order
7. Final messages are returned to OpenCode
```

### Image Attachment Flow (processImageAttachments)
```
1. Hook receives messages with image parts (type='image' or type='file' with image/* mime)
2. For each user message with images:
   a. Decode data URLs to binary data
   b. Generate SHA1 hash of image data for unique identification
   c. Save image to `.opencode/images/[sessionID]/` directory
   d. Create unique filename with hash to prevent collisions
   e. Replace image parts with text reference containing file paths
   f. Add informational text about image attachment for model context
3. Cleanup old images older than 60 minutes (debounced every 10 minutes)
```

### Hook Registration
```
1. Plugin initializes (src/index.ts)
2. Hook factories are called to create hook instances
3. Hooks are registered with OpenCode via `experimental.chat.messages.transform`
4. OpenCode invokes hooks during message lifecycle
```

## Integration

### Consumers
- **Main Plugin**: `src/index.ts` - registers hooks with OpenCode during plugin initialization
- **OpenCode Runtime**: Invokes hooks during `experimental.chat.messages.transform` API calls

### Dependencies
- **OpenCode SDK**: Type definitions for `MessageWithParts`, `MessageInfo`, and hook signatures
- **Node.js FS Module**: For saving image attachments to disk
- **Crypto Module**: For generating unique image hashes
- **Observer Agent**: Disabled agents check prevents image processing when observer is unavailable

### Configuration
- **Disabled Agents**: Hooks check `disabledAgents` set to skip processing when required agents are unavailable
- **Workspace Directory**: Images are saved to `.opencode/images/` within the project workspace

### Error Handling
- **File System Errors**: Logged but don't halt processing; hook continues with remaining messages
- **Collision Handling**: Unique filenames generated via counter suffix when hash collisions occur
- **Cleanup Failures**: Non-fatal; old images may persist but are periodically cleaned up

### Performance Considerations
- **Debounced Cleanup**: Image cleanup runs every 10 minutes per directory to avoid frequent filesystem operations
- **Session Isolation**: Images organized by sessionID to prevent cross-session contamination
- **Early Returns**: Hooks return immediately when no relevant messages found (e.g., no images to process)
