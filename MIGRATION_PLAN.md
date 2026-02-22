# Migration Plan: Token-Discipline Integration

**Goal**: Make token-discipline the core architecture, removing all duplicate/conflicting code.

---

## Phase 3: Remove Duplicates

### 3.1 Files to DELETE
None - we'll modify in place to preserve exports that may be referenced.

### 3.2 Files to MODIFY

| File | Action | Details |
|------|--------|---------|
| `src/config/schema.ts` | REMOVE PacketV1Schema | Re-export from token-discipline/types.ts |
| `src/config/index.ts` | UPDATE exports | Re-export PacketV1 from token-discipline |
| `src/background/background-manager.ts` | EXTEND base class | Create shared BaseTaskManager |
| `src/delegates/index.ts` | EXTEND base class | Inherit from BaseTaskManager |

### 3.3 Files to CREATE

| File | Purpose |
|------|---------|
| `src/task-manager/base.ts` | Shared task manager logic |
| `src/orchestration/packet-executor.ts` | Integrates airlock, thread-manager, metrics |

### 3.4 Files UNCHANGED

| File | Reason |
|------|--------|
| `src/token-discipline/*` | Core modules, already correct |
| `src/agents/*.ts` | Prompt changes only, not structure |
| `src/tools/grep.ts` | No changes needed |
| `src/tools/lsp/*` | No changes needed |
| `src/tools/ast-grep/*` | No changes needed |

---

## Phase 4-5: Thread Manager & Validator Integration

### Changes Required

**`src/delegates/index.ts`**:
```typescript
// BEFORE: processDelegateOutput() called but thread not archived
const result = await processDelegateOutput(ctx, role, responseText, messages, tokens);

// AFTER: processDelegateOutput already archives thread internally
// No changes needed - already integrated in orchestrator.ts
```

**`src/agents/*.ts` prompts**:
- Already include packet format instructions
- Need to ensure validation is enforced on output

---

## Phase 6: Airlock Integration

### Create `src/orchestration/packet-executor.ts`

```typescript
import { capToolOutput } from '../token-discipline/airlock';
import { storeToolOutput } from '../token-discipline/thread-manager';

// Wrap tool execution with airlock
export function executeWithCap(
  toolName: string,
  rawOutput: string,
  threadId: string
): { output: string; pointer: string } {
  const result = capToolOutput(toolName, rawOutput, threadId);
  
  // Store full output if capped
  if (result.capped) {
    storeToolOutput(threadId, result.pointer.replace('cmd:', ''), rawOutput);
  }
  
  return { output: result.output, pointer: result.pointer };
}
```

### Modify Tools

| Tool | Cap Applied | Integration Point |
|------|-------------|-------------------|
| bash | 250 lines | Wrap in packet-executor |
| git diff | 400 lines | Wrap in packet-executor |
| git log | 100 lines | Wrap in packet-executor |
| file read | 12KB | Wrap in packet-executor |

---

## Phase 7: Orchestrator Integration

### Current State
- `src/token-discipline/orchestrator.ts` defines functions but they're not called
- `src/agents/orchestrator.ts` is just a prompt, doesn't use the token-discipline orchestrator

### Changes Required

**Option A: LLM-based orchestration (current approach)**
- Orchestrator agent receives packets via packet_context tool
- Agent prompt instructs how to merge and act on packets
- No code changes to orchestrator flow

**Option B: Code-based orchestration**
- Replace LLM orchestrator with code from token-discipline/orchestrator.ts
- Use classifyAndRoute() for task routing
- Use mergePackets() for combining results

**Decision**: Keep Option A (LLM-based) but integrate:
1. Task classification hints in orchestrator prompt
2. Packet merger available as utility

---

## Phase 8: Routing Integration

### Add to `src/delegates/index.ts`

```typescript
import { classifyAndRoute, getSequentialDelegates } from '../token-discipline/task-router';

// In delegate_task tool:
const plan = classifyAndRoute(args.prompt);

// Launch delegates in sequence
for (const delegate of plan.delegates) {
  const agentName = roleToAgentName(delegate.role);
  await manager.launch({ agent: agentName, ... });
}
```

### Agent Name Mapping (already exists)
```typescript
const ROLE_TO_AGENT = {
  RESEARCHER: 'librarian',
  REPO_SCOUT: 'explorer', 
  IMPLEMENTER: 'fixer',
  VALIDATOR: 'oracle',
  DESIGNER: 'designer',
  SUMMARIZER: 'summarizer'
};
```

---

## Phase 9: MCP Restrictions

### Current State
All agents can access all MCPs via wildcard permissions.

### Changes Required

**`src/agents/index.ts`** - Add MCP restrictions per agent:

```typescript
const AGENT_MCP_ACCESS: Record<string, string[]> = {
  librarian: ['websearch', 'context7', 'grep_app'], // ONLY researcher
  explorer: [],
  oracle: [],
  designer: [],
  fixer: [],
  orchestrator: [], // Orchestrator receives packets, doesn't do research
  summarizer: [],
};

// In applyDefaultPermissions():
const allowedMcps = AGENT_MCP_ACCESS[agent.name] ?? [];
for (const mcp of ['websearch', 'context7', 'grep_app']) {
  agent.config.permission[`${mcp}_*`] = allowedMcps.includes(mcp) ? 'allow' : 'deny';
}
```

---

## Phase 10: Model Assignment Integration

### Current State
- Models defined in `DEFAULT_MODELS` constant
- `omoslim.json` has model_assignments but not used

### Changes Required

**`src/agents/index.ts`**:

```typescript
import { getModelForRole } from '../token-discipline/model-config-loader';

// In createAgents():
const roleModel = await getModelForRole(agentNameToRole(name));
const configModel = config?.agents?.[name]?.model;
const modelToUse = configModel ?? roleModel;
```

---

## Phase 11: Monitoring Integration

### Add to `src/delegates/index.ts`

```typescript
import {
  startTaskTracking,
  recordDelegateResult,
  recordPacketRejection,
  finalizeTaskTracking,
  setOrchestratorTokens,
} from '../token-discipline/metrics';

// In launch():
startTaskTracking(prompt);

// In extractAndCompleteTask():
if (result) {
  recordDelegateResult({
    packet: result.packet,
    threadId,
    role: task.role,
    modelUsed: task.modelUsed,
    tokenCount: task.tokenCount,
  });
} else {
  recordPacketRejection();
}

// When orchestrator context built:
setOrchestratorTokens(estimatedTokens);
finalizeTaskTracking();
```

---

## Phase 12: Testing

### Create `src/delegates/isolation.test.ts`

```typescript
describe('Packet Isolation', () => {
  test('orchestrator receives only packets', async () => {
    // Launch delegate, verify packet format in result
  });
  
  test('tool outputs are capped', async () => {
    // Execute bash with 1000 lines, verify 250 line cap
  });
  
  test('Context7 restricted to librarian', async () => {
    // Verify librarian has access, others don't
  });
  
  test('multi-delegate flow merges packets', async () => {
    // Launch multiple delegates, verify packet merger
  });
  
  test('model assignment from omoslim.json', async () => {
    // Change config, verify model changes
  });
});
```

---

## Execution Order

1. **Remove duplicate PacketV1** (Phase 3)
2. **Add MCP restrictions** (Phase 9)
3. **Connect model assignments** (Phase 10)
4. **Integrate airlock** (Phase 6)
5. **Add monitoring** (Phase 11)
6. **Add tests** (Phase 12)
7. **Consider routing integration** (Phase 8) - Optional enhancement

---

## Files Changed Summary

| File | Phase | Action |
|------|-------|--------|
| `src/config/schema.ts` | 3 | Remove PacketV1Schema |
| `src/config/index.ts` | 3 | Re-export PacketV1 |
| `src/agents/index.ts` | 9, 10 | Add MCP restrictions, model loading |
| `src/delegates/index.ts` | 6, 11 | Add airlock, metrics |
| `src/delegates/isolation.test.ts` | 12 | Create new |
| `CURRENT_ARCHITECTURE.md` | 1 | Created |
| `MIGRATION_PLAN.md` | 1 | This file |
