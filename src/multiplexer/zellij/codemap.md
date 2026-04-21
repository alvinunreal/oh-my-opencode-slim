# src/multiplexer/zellij/

## Responsibility

- Implement zellij-backed pane orchestration for delegated sessions as an alternative to tmux.
- Maintain a dedicated `opencode-agents` tab and route all spawned attach sessions into it.
- Keep process cleanup and first-run reuse behavior to avoid repeated pane inflation.

## Design

- `ZellijMultiplexer` in `index.ts` implements `Multiplexer`.
- `findBinary` is a simple `which/where zellij` probe with cached path.
- `isInsideSession` checks `process.env.ZELLIJ`; `isAvailable` uses cached `binaryPath`.
- First creation path builds/repurposes one dedicated tab (`opencode-agents`) via `ensureAgentTab` and tracks:
  - `agentTabId`
  - `firstPaneId`
  - `firstPaneUsed`
- Command composition is done by helper builders:
  - `buildOpencodeAttachCommand`
  - `buildShellLaunchCommand`
- Layout is intentionally a no-op because zellij does not expose equivalent layout APIs used by this codebase.

## Flow

- `spawnPane(sessionId, description, serverUrl, directory)`:
  - resolve zellij binary and call `ensureAgentTab`
  - if first pane in the agent tab is free, execute attach command in-place via `runInPane`:
    - `focus-pane --pane-id`
    - `rename-pane`
    - `write-chars` launch command + newline
  - otherwise create a new pane via `new-pane --name <desc> --close-on-exit -- sh -lc <opencode attach ...>`.
  - when called from user tab, temporarily switch to `agentTabId` and back to keep user context.
  - return `{ success, paneId }` where pane ids are validated as `terminal_*`.
- `closePane(paneId)`:
  - `action write --pane-id <id> \u0003` (graceful SIGINT equivalent)
  - wait 250ms
  - `action close-pane --pane-id <id>`; treats exit codes `0` and `1` as successful closure.
- `applyLayout` is intentionally no-op and retained for interface compatibility.

## Integration

- Selected by `getMultiplexer` in explicit `zellij` mode or env-driven `auto` when `process.env.ZELLIJ` is present.
- Consumed by `MultiplexerSessionManager` as the pane backend in zellij environments.
- UI attach command semantics are identical to tmux in argument shape: `opencode attach <url> --session <sessionId> --dir <directory>`, so delegated sessions remain config-agnostic across backends.
