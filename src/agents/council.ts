import { shortModelLabel } from '../utils/session';
import { type AgentDefinition, resolvePrompt } from './orchestrator';

// NOTE: Councillor system prompts live in the councillor agent factory.
// The format functions below only structure the USER message content — the
// agent factory provides the system prompt.

const COUNCIL_AGENT_PROMPT = `You are the Council agent — a multi-LLM \
orchestration system that runs consensus across multiple models.

**Tool**: You have access to the \`council_session\` tool.

**When to use**:
- When invoked by a user with a request
- When you want multiple expert opinions on a complex problem
- When higher confidence is needed through model consensus

**Usage**:
1. Call the \`council_session\` tool with the user's prompt
2. Optionally specify a preset (default: "default")
3. Receive the councillor responses formatted for synthesis
4. Synthesize the optimal final answer from the councillor responses
5. Present the synthesized result to the user

**Synthesis Guidelines**:
When you receive councillor responses, synthesize them into the optimal final answer:
- Review all councillor responses thoroughly and create the best possible answer
- Credit specific insights from individual councillors by name (e.g., "alpha noted that...", "beta suggested...")
- Clearly explain your reasoning for the chosen approach
- Be transparent about trade-offs when different approaches have valid pros/cons
- Note any remaining uncertainties or areas where further investigation is needed
- If councillors disagree, explain the resolution and your reasoning
- Acknowledge if consensus was impossible and explain why
- Don't just average responses — choose the best approach and improve upon it
- Present the synthesized solution with relevant code examples, concrete details, and clear explanations

**Behavior**:
- Delegate requests directly to council_session
- Don't pre-analyze or filter the prompt before calling council_session
- Synthesize the councillor results into a comprehensive, coherent answer
- Include attribution for valuable insights from specific councillors
- If councillors disagree, explain why you chose one approach over another`;

export function createCouncilAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const prompt = resolvePrompt(
    COUNCIL_AGENT_PROMPT,
    customPrompt,
    customAppendPrompt,
  );

  const definition: AgentDefinition = {
    name: 'council',
    description:
      'Multi-LLM council agent that synthesizes responses from multiple models for higher-quality outputs',
    config: {
      temperature: 0.1,
      prompt,
    },
  };

  // Council's model comes from config override or is resolved at
  // runtime; only set if a non-empty string is provided.
  if (model) {
    definition.config.model = model;
  }

  return definition;
}

/**
 * Build the prompt for a specific councillor session.
 *
 * Returns the raw user prompt — the agent factory (councillor.ts) provides
 * the system prompt with tool-aware instructions. No duplication.
 *
 * If a per-councillor prompt override is provided, it is prepended as
 * role/guidance context before the user's question.
 */
export function formatCouncillorPrompt(
  userPrompt: string,
  councillorPrompt?: string,
): string {
  if (!councillorPrompt) return userPrompt;
  return `${councillorPrompt}\n\n---\n\n${userPrompt}`;
}

/**
 * Format councillor results for the council agent to synthesize.
 *
 * Formats councillor results as structured data that the council agent
 * (which called the tool) will receive as the tool response. The council
 * agent's system prompt contains synthesis instructions.
 * Returns a special message when all councillors failed to produce output.
 */
export function formatCouncillorResults(
  originalPrompt: string,
  councillorResults: Array<{
    name: string;
    model: string;
    status: string;
    result?: string;
    error?: string;
  }>,
): string {
  const completedWithResults = councillorResults.filter(
    (cr) => cr.status === 'completed' && cr.result,
  );

  const councillorSection = completedWithResults
    .map((cr) => {
      const shortModel = shortModelLabel(cr.model);
      return `**${cr.name}** (${shortModel}):\n${cr.result}`;
    })
    .join('\n\n');

  const failedSection = councillorResults
    .filter((cr) => cr.status !== 'completed')
    .map((cr) => `**${cr.name}**: ${cr.status} — ${cr.error ?? 'Unknown'}`)
    .join('\n');

  // Defensive guard: caller (runCouncil) short-circuits when all fail,
  // but this function may be reused in other contexts.
  if (completedWithResults.length === 0) {
    const errorDetails = councillorResults
      .map(
        (cr) =>
          `**${cr.name}** (${shortModelLabel(cr.model)}): ${cr.status} — ${cr.error ?? 'Unknown'}`,
      )
      .join('\n');

    return `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\nAll councillors failed to produce output:\n${errorDetails}\n\nPlease generate a response based on the original prompt alone.`;
  }

  let prompt = `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\n${councillorSection}`;

  if (failedSection) {
    prompt += `\n\n---\n\n**Failed/Timed-out Councillors**:\n${failedSection}`;
  }

  prompt += '\n\n---\n\nSynthesize the optimal response based on the above.';

  return prompt;
}
