import { type AgentDefinition, resolvePrompt } from './orchestrator';

/**
 * Council Master agent — pure synthesis engine.
 *
 * The master receives all councillor responses and produces the final
 * synthesized answer. It has NO tools — synthesis is a text-in/text-out
 * operation. Councillors already did the research.
 *
 * Permission model mirrors OpenCode's built-in compaction/title/summary
 * agents: deny all.
 */
const COUNCIL_MASTER_PROMPT = `You are the council master responsible for \
synthesizing responses from multiple AI models.

**Role**: Review all councillor responses and create the optimal final answer.

**Process**:
1. Read the original user prompt
2. Review each councillor's response carefully
3. Identify the best elements from each response
4. Resolve contradictions between councillors
5. Synthesize a final, optimal response

**Behavior**:
- Each councillor had read-only access to the codebase — their responses may \
  reference specific files, functions, and line numbers
- Clearly explain your reasoning for the chosen approach
- Be transparent about trade-offs
- Credit specific insights from individual councillors by name
- If councillors disagree, explain your resolution
- Don't just average responses — choose and improve

**Output**:
- Present the synthesized solution
- Review, retain, and include relevant code examples, diagrams, and concrete \
  details from councillor responses
- Explain your synthesis reasoning
- Note any remaining uncertainties
- Acknowledge if consensus was impossible`;

export function createCouncilMasterAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const prompt = resolvePrompt(
    COUNCIL_MASTER_PROMPT,
    customPrompt,
    customAppendPrompt,
  );

  return {
    name: 'council-master',
    description:
      'Council synthesis engine. Receives councillor responses and produces the final answer. No tools, pure text synthesis.',
    config: {
      model,
      temperature: 0.1,
      prompt,
      // Deny everything — pure synthesis, no tools needed.
      // Explicit question:deny prevents applyDefaultPermissions from
      // re-enabling it (it only preserves an existing 'deny' value).
      permission: {
        '*': 'deny',
        question: 'deny',
      },
    },
  };
}
