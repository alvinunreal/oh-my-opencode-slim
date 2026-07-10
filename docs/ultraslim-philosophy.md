# Ultraslim Philosophy

oh-my-opencode-ultraslim is a fork of oh-my-opencode-slim with a fundamentally different orchestration philosophy: **the orchestrator is a pure dispatcher**.

## Core Principle

The orchestrator does NOT plan, code, research, design, or review. It only:
- **Delegates** tasks to specialized agents
- **Validates** results from specialists
- **Dispatches** work in parallel where possible
- **Verifies** outcomes meet requirements
- **Reconciles** results from multiple agents
- **Escalates** to Oracle when problems persist

## Why This Matters

### Cost Optimization
- Use the **cheapest capable model** for dispatching (orchestrator)
- Reserve your **most capable reasoning model** for planning and architecture (Oracle)
- Fast, efficient models for reconnaissance and research (Explorer, Librarian)

### Quality Improvement
- Specialists do specialized work with focused prompts
- Orchestrator coordinates without contaminating its context with implementation details
- Oracle provides deep architectural insight when needed

### Speed
- Parallel delegation of independent tasks
- No waiting for orchestrator to "think through" implementation
- Clear separation of planning vs execution

## The 5-Phase Workflow

```
1. PARSE → 2. PLAN (Oracle) → 3. DISPATCH → 4. VERIFY → 5. RECONCILE
```

### 1. Parse
Orchestrator understands the user's request and identifies what needs to be done.

### 2. Plan (Oracle)
For complex tasks, Orchestrator delegates to Oracle who returns a structured plan:
- Goal Analysis
- Approach
- File Scope
- Dependencies
- Risk Assessment
- Verification Criteria

### 3. Dispatch
Orchestrator launches specialist agents based on the plan:
- @explorer for codebase reconnaissance
- @librarian for external knowledge
- @fixer for implementation
- @designer for UI/UX work
- @oracle for architecture decisions

### 4. Verify
Orchestrator validates results using read-only operations and terminal commands (tests, builds, linting).

### 5. Reconcile
Orchestrator integrates outcomes, handles conflicts between parallel agents, and reports final results.

## Three-Strike Escalation

If Fixer fails 3 times on the same task:
1. First failure: Orchestrator retries with clearer instructions
2. Second failure: Orchestrator provides more context/constraints
3. Third failure: **Escalate to Oracle** for root cause analysis

Oracle performs deep investigation and provides guidance to break the failure cycle.

## Agent Roles

| Agent | Role | Model Recommendation |
|-------|------|---------------------|
| **Orchestrator** | Pure dispatcher (no planning/coding/reviewing) | Cheapest capable model |
| **Oracle** | Planner + architecture advisor + debugger of last resort | Most capable reasoning model |
| **Fixer** | Pure executor (no tests, no decisions) | Reliable coding model |
| **Explorer** | Codebase reconnaissance | Fast, low-cost model |
| **Librarian** | External knowledge retrieval | Fast, low-cost model |
| **Designer** | UI/UX implementation | Model strong at visual design |
| **Council** | Multi-LLM consensus | Strong synthesis model |

## The ultraslim Preset

The `ultraslim` preset embodies this philosophy with model mappings that optimize for cost-quality balance:

```jsonc
{
  "preset": "ultraslim",
  "presets": {
    "ultraslim": {
      // Cheapest capable model for dispatching
      "orchestrator": { "model": "your-cheapest-model" },
      // Most capable reasoning model for planning
      "oracle": { "model": "your-strongest-model" },
      // Fast models for specialists
      "fixer": { "model": "your-efficient-coding-model" },
      "explorer": { "model": "your-fast-model" },
      "librarian": { "model": "your-fast-model" }
    }
  }
}
```

## Comparison with oh-my-opencode-slim

| Aspect | slim | ultraslim |
|--------|------|-----------|
| Orchestrator | Plans, codes, reviews, delegates | Pure dispatcher only |
| Oracle | Advisory only | Planner + architecture advisor |
| Fixer | Can run validation | Pure executor (no tests) |
| Workflow | Flexible | Structured 5-phase |
| Escalation | Implicit | Explicit three-strike rule |
| Model strategy | Strong orchestrator | Cheapest orchestrator, strongest Oracle |

## When to Use Ultraslim

Choose ultraslim when you want:
- Maximum cost efficiency through model specialization
- Clear separation of planning vs execution
- Structured workflow for complex multi-file changes
- Oracle as the strategic brain, Orchestrator as the coordinator

Choose slim when you want:
- A single strong orchestrator that can handle everything
- Less structured, more flexible workflow
- Simpler model configuration