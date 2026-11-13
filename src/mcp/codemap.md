# src/mcp/

## Responsibility

Defines Model Context Protocol (MCP) server configurations and integrations for the OpenCode plugin. This module provides built-in MCP servers for documentation lookup and code search, enabling agents to access external tools and resources via the MCP standard.

## Design

The `src/mcp/` directory implements a modular MCP configuration system with the following architecture:

- **Type definitions** (`types.ts`): Core type system for MCP configurations (RemoteMcpConfig, LocalMcpConfig, McpConfig)
- **Built-in MCP servers**: Pre-configured remote MCP endpoints for common development tasks
- **Factory pattern** (`index.ts`): Centralized creation and management of MCP configurations with user-configurable overrides

### MCP Server Types Supported

| Type | Purpose | Example Use Case |
|------|---------|----------------|
| RemoteMcpConfig | Connects to hosted MCP servers via URL | Documentation lookup, code search |
| LocalMcpConfig | Spawns local processes as MCP servers | Custom tool integrations |

### Built-in MCP Servers

1. **context7** (`context7.ts`)
   - Purpose: Official documentation lookup for libraries
   - Endpoint: https://mcp.context7.com/mcp
   - Authentication: CONTEXT7_API_KEY environment variable

2. **gh_grep** (`grep-app.ts`)
   - Purpose: Ultra-fast code search across GitHub repositories
   - Endpoint: https://mcp.grep.app
   - Use case: Finding code examples and patterns in public repositories

## Flow

### Initialization Flow

```
Plugin loads → createBuiltinMcps() called with disabledMcps list
  ↓
Filters built-in MCP list to exclude disabled servers
  ↓
Creates RemoteMcpConfig instances for each enabled server
  ↓
Returns record of McpConfig objects to main plugin
```

### Runtime Flow

1. **Configuration phase** (at plugin initialization):
   - `createBuiltinMcps()` is called from `src/index.ts`
   - User configuration is merged with defaults, **user wins on key collisions**
     (a user-defined `mcp.<name>` entry is never replaced by a built-in; see
     `getOverriddenBuiltinMcpKeys()` and issue #1290)
   - Disabled MCPs are filtered out

2. **Integration phase** (during agent execution):
   - MCP servers are registered with the MCP runtime
   - Agents request tool calls via MCP protocol
   - MCP servers execute requests and return results to agents

## Integration


### Consumer Modules

- **Primary consumer**: `src/index.ts` - Main plugin entry point
  - Calls `createBuiltinMcps()` during plugin initialization
  - Receives McpConfig record and registers MCPs with OpenCode

- **Configuration layer**: `src/config/` - Provides McpName type and MCP configuration schemas
  - Defines MCP names and configuration schemas
  - Validates user-provided MCP configurations


### Dependencies

- **Environment variables**:
  - `CONTEXT7_API_KEY` - API key for Context7 documentation lookup


- **Type system**: Shares `McpName` type with `src/config/` to avoid duplication


### API Surface

- **Exported types**: `RemoteMcpConfig`, `McpConfig` from `types.ts`
- **Exported functions**: `createBuiltinMcps()` from `index.ts`, plus
  `getOverriddenBuiltinMcpKeys(builtin, user)` which returns the built-in
  names the user already defines so callers can suppress injection for those
  keys
- **Pre-configured servers**: `context7`, `gh_grep` constants

### Configuration Overrides


The system supports runtime configuration overrides:


```typescript
// In user configuration (e.g., ~/.config/opencode/oh-my-opencode-slim.json)
{
  "mcp": {
    "disabled": ["gh_grep"]
  }
}
```


This allows users to:
- Disable specific MCP servers
- Customize API keys and endpoints


## Error Handling


- **Missing API keys**: Throws descriptive errors for required keys (e.g., CONTEXT7_API_KEY)
- **Invalid configurations**: TypeScript type system prevents invalid configurations at compile time
- **Disabled servers**: Gracefully filtered from output without errors

## Testing

- **Unit tests**: `index.test.ts` validates MCP creation and filtering logic
- **Integration tests**: MCP servers are tested via integration with OpenCode's MCP runtime

- **Configuration tests**: Schema validation ensures user configurations match expected types


## Performance Considerations

- **Lazy initialization**: MCPs are created once at plugin initialization
- **Minimal overhead**: Type-safe configuration with no runtime parsing
- **Connection pooling**: Remote MCP servers handle their own connection management


## Security

- **API keys**: Never hardcoded; always sourced from environment variables
- **OAuth**: Disabled for all built-in MCPs (oauth: false)
- **Input validation**: TypeScript ensures configuration correctness
- **HTTPS**: All remote endpoints use HTTPS for secure communication