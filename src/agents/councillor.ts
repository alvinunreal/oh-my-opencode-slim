import { type AgentDefinition, resolvePrompt } from './orchestrator';

/**
 * Councillor agent — a read-only advisor in the multi-LLM council.
 *
 * Councillors are spawned by CouncilManager as agent sessions (visible in
 * tmux/UI). They have read-only access to the codebase via tools but CANNOT
 * modify files, run shell commands, or spawn subagents.
 *
 * Permission model mirrors OpenCode's built-in `explore` agent:
 * deny all, then selectively allow read-only tools.
 *
 * The per-councillor model is overridden at session creation time via the
 * `model` field in the prompt body — the agent factory's default model is
 * just a fallback.
 */
const COUNCILLOR_PROMPT = `You are a councillor in a multi-model council.

**Role**: Provide your best independent analysis and solution to the given \
problem.

**Capabilities**: You have read-only access to the codebase. You can:
- Read files (read)
- Search by name patterns (glob)
- Search by content (grep)
- Query language server (lsp_diagnostics, lsp_goto_definition, lsp_find_references)
- Search code patterns (ast_grep_search)
- Search external docs (if MCPs are configured for this agent)

You CANNOT edit files, write files, run shell commands, or delegate to \
other agents. You are an advisor, not an implementer.

**Behavior**:
- **Examine the codebase** before answering — your read access is what makes \
  council valuable. Don't guess at code you can see.
- Analyze the problem thoroughly
- Provide a complete, well-reasoned response
- Focus on the quality and correctness of your solution
- Be direct and concise
- Don't be influenced by what other councillors might say — you won't see \
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
): AgentDefinition {
  const prompt = resolvePrompt(
    COUNCILLOR_PROMPT,
    customPrompt,
    customAppendPrompt,
  );

  return {
    name: 'councillor',
    description:
      'Read-only council advisor. Examines codebase and provides independent analysis. Spawned internally by the council system.',
    config: {
      model,
      temperature: 0.2,
      prompt,
      // Mirror OpenCode's explore agent: deny all, then allow read-only tools
      permission: {
        '*': 'deny',
        question: 'deny',
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        lsp: 'allow',
        list: 'allow',
        codesearch: 'allow',
      },
    },
  };
}
