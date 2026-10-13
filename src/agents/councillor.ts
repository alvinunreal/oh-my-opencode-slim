import { NO_SHELL_READONLY_FILE_OPERATIONS_RULES } from '../config';
import { type AgentDefinition, resolvePrompt } from './orchestrator';
import {
  createReadOnlyAgentPermission,
  TASK_OBSERVER_DISPATCH_ONLY,
} from './permissions';

/**
 * Councillor agent - a read-only advisor in the multi-LLM council.
 *
 * Councillors are dispatched by the orchestrator (via `task()` on v1,
 * `subagent()` on v2) as agent sessions
 * (visible in tmux/UI). They have read-only access to the codebase via tools
 * but CANNOT modify files, run shell commands, or spawn subagents.
 *
 * Permission model mirrors OpenCode's built-in `explore` agent:
 * deny all, then selectively allow read-only tools.
 *
 * The per-councillor model is overridden at session creation time via the
 * `model` field in the prompt body - the agent factory's default model is
 * just a fallback.
 */
const COUNCILLOR_PROMPT = `You are a councillor in a multi-model council.

**Role**: Provide your best independent analysis and solution to the given \
problem.

**Capabilities**: You have read-only access to the codebase. You can:
- Read files (read)
- Search by name patterns (glob)
- Search by content (grep)
- Search code patterns (ast_grep_search)
- Use OpenCode's built-in \`lsp\` tool when available
- Search external docs (if MCPs are configured for this agent)

You CANNOT edit files, write files, run shell commands, or delegate to \
other agents. You are an advisor, not an implementer.

${NO_SHELL_READONLY_FILE_OPERATIONS_RULES}

**Behavior**:
- **Examine the codebase** before answering - your read access is what makes \
  council valuable. Don't guess at code you can see.
- Analyze the problem thoroughly
- Provide a complete, well-reasoned response
- Focus on the quality and correctness of your solution
- Be direct and concise
- Don't be influenced by what other councillors might say - you won't see \
  their responses

**Output**:
- Give your honest assessment
- Reference specific files and line numbers when relevant
- Include relevant reasoning
- State any assumptions clearly
- Note any uncertainties`;

export function createCouncillorAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
  variant?: string,
  observerDispatchEnabled = false,
): AgentDefinition {
  const prompt = resolvePrompt(
    'councillor',
    customPrompt,
    undefined,
    COUNCILLOR_PROMPT,
    customAppendPrompt,
  );

  return {
    name: 'councillor',
    description:
      'Read-only council advisor providing independent codebase analysis.',
    config: {
      model,
      variant,
      prompt,
      // Strict read-only allowlist: deny all, then allow inspection tools
      // only. `task` stays at the blanket deny unless nested dispatch is
      // live (v2 + observer enabled), where it narrows to observer-only so
      // a councillor can have images read for it without gaining any other
      // spawning capability.
      permission: {
        ...createReadOnlyAgentPermission(),
        task: observerDispatchEnabled
          ? { ...TASK_OBSERVER_DISPATCH_ONLY }
          : 'deny',
      },
    },
  };
}
