# Current Architecture Analysis

**Date**: 2024-02-22
**Plugin**: oh-my-opencode-slim

## Executive Summary

The plugin implements a multi-agent orchestration system with **two parallel task execution systems** and a **token discipline subsystem** that is partially integrated.

### Critical Issues Found
1. **Duplicate PacketV1 schema** in `config/schema.ts` and `token-discipline/types.ts`
2. **85% code duplication** between `BackgroundTaskManager` and `PacketTaskManager`
3. **Token discipline features exist but aren't used** (orchestrator, airlock, routing, metrics)
4. **No tool output capping** - raw outputs leak to delegate context

---

## 1. Entry Points

### Main Plugin (`src/index.ts`)
```
Plugin init flow:
1. setConfigDirectory(ctx.directory)
2. loadPluginConfig() -> PluginConfig
3. getAgentConfigs() -> SDK configs
4. Create managers:
   - BackgroundTaskManager (raw outputs)
   - PacketTaskManager (packet extraction) 
   - TmuxSessionManager (pane management)
5. Create tools: background_*, delegate_*, lsp_*, grep
6. Register event handlers for session lifecycle
```

### CLI (`src/cli/index.ts`)
- `install` command for setup
- `models` command for model selection

---

## 2. Agent System

### Agent Definitions (`src/agents/*.ts`)

| Agent | Role | Delegates To | Current MCPs |
|-------|------|--------------|--------------|
| orchestrator | Primary | All subagents | websearch, context7, grep_app |
| librarian | Researcher | None | websearch, context7, grep_app |
| explorer | Repo Scout | None | None |
| oracle | Validator | None | None |
| designer | Designer | explorer | None |
| fixer | Implementer | explorer | None |
| summarizer | Summarizer | None | None |

### Delegation Rules (`src/config/constants.ts`)
```typescript
SUBAGENT_DELEGATION_RULES = {
  orchestrator: ['explorer', 'librarian', 'oracle', 'designer', 'fixer', 'summarizer'],
  fixer: ['explorer'],
  designer: ['explorer'],
  // All others: [] (leaf nodes)
}
```

### Problem: MCP Access Not Restricted
All agents have access to all MCPs via wildcard permissions. Context7/WebSearch should be researcher-only.

---

## 3. Configuration System

### Config Files
- User: `~/.config/opencode/oh-my-opencode-slim.jsonc`
- Project: `<project>/.opencode/oh-my-opencode-slim.jsonc`
- Token Discipline: `omoslim.json` (NEW, not integrated)

### Schema (`src/config/schema.ts`)
```typescript
PluginConfig {
  agents?: Record<string, AgentOverrideConfig>; // model, temperature, variant
  presets?: Record<string, Preset>;
  tmux?: TmuxConfig;
  fallback?: FailoverConfig;
  tokenDiscipline?: TokenDisciplineConfig; // Not connected to omoslim.json!
}
```

### Problem: Dual Config Systems
- `PluginConfig` handles agents and fallbacks
- `omoslim.json` handles token discipline model assignments
- These are **not connected** - model assignments in omoslim.json aren't used by agents

---

## 4. Task Management (85% Duplicated Code)

### BackgroundTaskManager (`src/background/background-manager.ts`)
- Tools: `background_task`, `background_output`, `background_cancel`
- Returns: Raw text output
- ~734 lines

### PacketTaskManager (`src/delegates/index.ts`)  
- Tools: `delegate_task`, `packet_context`
- Returns: ValidatedPacket
- ~798 lines

### Shared Methods (Duplicates)
| Method | BackgroundTaskManager | PacketTaskManager |
|--------|----------------------|-------------------|
| launch() | ✓ | ✓ (90% similar) |
| enqueueStart() | ✓ | ✓ (100% same) |
| processQueue() | ✓ | ✓ (100% same) |
| startTask() | ✓ | ✓ (80% similar) |
| handleSessionStatus() | ✓ | ✓ (95% same) |
| handleSessionDeleted() | ✓ | ✓ (95% same) |
| extractAndCompleteTask() | ✓ | ✓ (85% similar) |
| completeTask() | ✓ | ✓ (90% similar) |
| waitForCompletion() | ✓ | ✓ (100% same) |
| cancel() | ✓ | ✓ (95% similar) |
| isAgentAllowed() | ✓ | ✓ (100% same) |
| getAllowedSubagents() | ✓ | ✓ (100% same) |

---

## 5. Token Discipline Subsystem (Exists but Unused)

### Available Modules
| Module | Status | Integration |
|--------|--------|-------------|
| `orchestrator.ts` | ⚠️ Defined | Not called from main flow |
| `thread-manager.ts` | ⚠️ Defined | Not integrated with task managers |
| `validator.ts` | ✅ Used | Via processDelegateOutput |
| `packet-merger.ts` | ⚠️ Defined | Not called |
| `task-router.ts` | ⚠️ Defined | Not integrated |
| `airlock.ts` | ❌ Not used | Tools return uncapped outputs |
| `metrics.ts` | ⚠️ Defined | Not connected to logging |
| `pointer-resolver.ts` | ⚠️ Defined | Not connected |
| `context-cleaner.ts` | ⚠️ Defined | extractPacketFromResponse not used |

### Critical Gap: No Airlock
```typescript
// Current: Tools return raw outputs
const output = await executeBashCommand("npm test"); // Could be 10,000 lines!

// Should be: Airlock caps outputs
const capped = capToolOutput("bash", output, threadId);
// Returns max 250 lines + pointer to full output
```

---

## 6. Communication Flow

### Current Flow (Broken)
```
[Orchestrator]
     |
     v delegate_task
[PacketTaskManager]
     |
     v creates session
[Subagent Session]
     | 
     v session.status=idle
[extractAndCompleteTask]
     |
     v processDelegateOutput()
[ValidatedPacket] -- BUT: 
     |  - Tool outputs NOT capped (airlock not used)
     |  - Thread NOT archived (thread-manager not called)
     |  - Metrics NOT tracked
     v
[Orchestrator] -- Receives packet, but subagent had full context bloat
```

### Desired Flow
```
[Orchestrator] -- initializeTask() classifies and routes
     |
     v spawnDelegate() for each role (via task-router)
[Subagent Session]
     | -- Tool calls wrapped with capToolOutput()
     | -- Full outputs stored via storeToolOutput()
     v
[ValidatedPacket] -- validatePacketV1() enforced
     | -- Thread archived via finalizeThread()
     | -- Metrics recorded via recordDelegateResult()
     v
[Orchestrator] -- Receives ONLY packets via buildPacketContext()
     | -- Can merge via mergePackets() if multiple
     v
[User] -- Token usage reduced 70-90%
```

---

## 7. Duplicate Type Definitions

### PacketV1 (Duplicate!)
**`src/config/schema.ts:3-12`**
```typescript
export const PacketV1Schema = z.object({...});
export type PacketV1 = z.infer<typeof PacketV1Schema>;
```

**`src/token-discipline/types.ts:4-13`**
```typescript
export const PacketV1Schema = z.object({...}); // IDENTICAL!
export type PacketV1 = z.infer<typeof PacketV1Schema>;
```

### AgentRole vs AgentName
- `AgentRole` (token-discipline): ORCHESTRATOR, RESEARCHER, REPO_SCOUT, etc.
- `AgentName` (config): orchestrator, librarian, explorer, etc.
- Mapping exists in `model-config.ts` but not unified

---

## 8. File Dependency Graph

```
src/index.ts
├── agents/index.ts
│   ├── orchestrator.ts, librarian.ts, explorer.ts, fixer.ts, oracle.ts, designer.ts
│   └── config/loader.ts -> PluginConfig
├── background/background-manager.ts (734 lines)
│   └── tools/background.ts
├── delegates/index.ts (798 lines, 85% duplicate of above)
│   ├── token-discipline/orchestrator.ts (processDelegateOutput only used)
│   ├── token-discipline/types.ts
│   └── token-discipline/validator.ts
├── token-discipline/ (mostly unused!)
│   ├── thread-manager.ts ❌ not integrated
│   ├── airlock.ts ❌ not used
│   ├── metrics.ts ❌ not connected
│   ├── packet-merger.ts ❌ not called
│   ├── task-router.ts ❌ not integrated
│   └── pointer-resolver.ts ❌ not connected
├── config/schema.ts (PacketV1 DUPLICATE!)
└── mcp/index.ts (websearch, context7, grep_app - no role restrictions)
```

---

## 9. Test Coverage Gaps

### Missing Tests
1. Packet isolation (orchestrator receives only packets)
2. Tool output capping (airlock enforcement)
3. Context7 restriction to researcher
4. Multi-delegate flow with packet merging
5. Model assignment from omoslim.json
6. Thread archiving
7. Pointer resolution

---

## 10. Summary of Work Needed

### Critical (Blocking)
1. Remove duplicate PacketV1 from config/schema.ts
2. Integrate airlock into tool execution
3. Connect omoslim.json model assignments to agents
4. Restrict Context7/WebSearch to librarian only

### High Priority
5. Integrate thread-manager for archiving
6. Integrate task-router for classification
7. Integrate metrics for tracking
8. Merge duplicate task manager code

### Medium Priority  
9. Integrate packet-merger for multi-delegate
10. Integrate pointer-resolver for drill-down
11. Add isolation verification tests
