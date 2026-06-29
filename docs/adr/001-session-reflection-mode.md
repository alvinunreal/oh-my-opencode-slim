# ADR-001: Session Reflection Mode for /reflect

**Date:** 2026-06-29
**Status:** Accepted
**Deciders:** User + Orchestrator

## Context

We are adding a `--sessions` mode to the `/reflect` command in oh-my-opencode-slim. This mode enables cross-session reflection by analyzing past OpenCode sessions to find repeated patterns, friction, and improvement opportunities.

Current `/reflect` only looks at the current conversation and project files. The new mode analyzes historical sessions across all repos to find patterns like:
- "Which workflows succeed most often?"
- "Which agents get stuck?"
- "Which models cause retries?"
- "What precedes successful completions?"

## Decisions

### 1. Implementation Approach: Prompt-only

**Decision:** Extend the reflect skill (SKILL.md) with instructions for session reflection. No new code tools or command hooks.

**Rationale:**
- Consistent with how `/reflect` currently works (prompt-based guidance)
- The LLM already has tools (Read, Write, Bash) to do everything needed
- Smallest useful form — no code changes required
- YAGNI: Start simple, add code if prompt-only proves insufficient

**Alternatives considered:**
- Hybrid (skill + command hook): More reliable enumeration, but adds code complexity
- Full code (new tool): Fastest execution, but most complex

### 2. Command Syntax

**Decision:** Remove `--global` (never shipped), add `--sessions` flag.

```
/reflect                          # Local mode (current repo)
/reflect release workflow         # Local mode, focused theme
/reflect --sessions               # Session archaeology (last 50 sessions)
/reflect --sessions --last 20     # Session archaeology, last 20
/reflect --sessions release workflow  # Session archaeology, focused theme
```

**Rationale:**
- `--global` was never rolled out, so no migration needed
- `--sessions` clearly describes the mode's purpose
- `--last N` provides user control over scope

### 3. Session Discovery

**Decision:** LLM reads `~/.local/share/opencode/log/opencode.log` and greps for `session.id=ses_[a-f0-9]+` to extract session IDs.

**Rationale:**
- Session IDs are reliably present in the main OpenCode log
- Pattern is stable and parseable with simple grep
- No new API dependencies needed

**Log format:**
```
timestamp=2026-06-10T15:08:45.427Z level=INFO run=9bd29194 message=loop session.id=ses_14de9c68effegtZtlATm42wnz7 step=0
```

### 4. Session Scope

**Decision:** Analyze last N sessions total (regardless of project), not per-project.

**Rationale:**
- Simpler to implement
- Patterns emerge naturally across repos
- User controls scope with `--last N`
- Per-project caps can be added later if needed

**Default:** 50 sessions
**Maximum:** 100 sessions (cap to avoid context explosion)

### 5. Storage Location

**Decision:** Store reflection summaries in `~/.config/opencode/oh-my-opencode-slim/reflections/`.

**Rationale:**
- Existing OMOS directory already contains presets, prompts, orchestrator_append.md
- Pragmatic: keeps all OMOS data in one place
- Easy discovery and cleanup
- Global across projects (sessions are not project-specific)

**Structure:**
```
~/.config/opencode/oh-my-opencode-slim/reflections/
  sessions/
    ses_14de9c68effegtZtlATm42wnz7.json
  weekly/
    week-26.json
  monthly/
    month-06.json
```

**Alternatives considered:**
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `~/.config/opencode/oh-my-opencode-slim/reflections/` | Existing directory, single location | Mixes config and data | **Accepted** |
| `~/.local/share/oh-my-opencode-slim/reflections/` | XDG-compliant, data separation | New directory, splits OMOS data | Rejected |
| `.slim/reflections/` (project-local) | Tied to codebase | Sessions are global, not project-specific | Rejected |
| Ephemeral (no storage) | No disk overhead | Re-analyzes expensive sessions, no trend tracking | Rejected |

### 6. Two-Phase Architecture

**Decision:** Per-session reflection first, then aggregation.

**Rationale:**
- Scalable: processes one session at a time (not hundreds in context)
- Aggregation works on concise summaries (20-30k tokens) not raw sessions (millions)
- Enables hierarchical aggregation: session → weekly → monthly

**Flow:**
```
OpenCode logs
  → Extract session IDs
  → For each session:
      → Load via client.session.messages()
      → Analyze and produce structured summary
      → Store in reflections/sessions/<id>.json
  → Aggregate all summaries
  → Produce final recommendations
```

### 7. Cache Pattern

**Decision:** LLM manages its own cache using Read/Write tools.

**Rationale:**
- No new code needed — LLM already has file tools
- Avoids re-analyzing expensive sessions
- Enables incremental updates (only analyze new sessions)

**Logic:**
1. Check if `reflections/sessions/<id>.json` exists
2. If yes, load it (saves tokens)
3. If no, analyze session and save summary
4. Aggregate across all summaries for final report

### 8. Per-Session Analysis

**Decision:** Each session produces a structured JSON summary with metadata, frictions, and recommendations.

**Schema:**
```json
{
  "session": "ses_14de9c68effegtZtlATm42wnz7",
  "project": "/home/user/Projects/oh-my-opencode-slim",
  "timestamp": "2026-06-10T15:08:45.427Z",
  "goal": "Fix CI failure",
  "success": true,
  "frictions": [
    "Repeated grep to find test file",
    "Three failed test runs before passing"
  ],
  "recommendations": [
    "Create /test-ci command"
  ],
  "duration_minutes": 18,
  "models_used": ["opencode/mimo-v2.5-free"],
  "agents_used": ["orchestrator", "fixer", "explorer"],
  "tools_used": ["Read", "Edit", "Bash"],
  "confidence": 0.85
}
```

**Confidence scoring:**
- 0.9-1.0: Clear success/failure, obvious patterns
- 0.7-0.9: Likely outcome, patterns inferred from tool usage
- 0.5-0.7: Uncertain outcome, limited evidence
- <0.5: Skip or mark as "needs more evidence"

## Implementation Notes

- The LLM manages its own cache using Read/Write tools
- Reflection files are JSON with session metadata, frictions, and recommendations
- Hierarchical aggregation: session → weekly → monthly summaries
- Old reflections can be pruned by age or count (configurable)
- Skill instructions guide the LLM through the full workflow

## Consequences

- No code changes needed — purely skill instruction updates
- All OMOS persistent data lives in one directory tree
- Reflections are available across all projects (global)
- LLM manages file I/O, cache, and aggregation
- Users can inspect or delete reflections manually
- Hierarchical aggregation (weekly/monthly) is possible via stored summaries
- Per-project session caps can be added later if needed
