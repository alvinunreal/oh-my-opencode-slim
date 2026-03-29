import { shortModelLabel } from '../utils/session';
import { type AgentDefinition, resolvePrompt } from './orchestrator';

// NOTE: Councillor and master system prompts live in their respective agent
// factories (councillor.ts, council-master.ts). The format functions below
// only structure the USER message content — the agent factory provides the
// system prompt. This avoids duplicate system prompts (Oracle finding #1/#2).

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
3. Receive the synthesized response from the council master
4. Present the result to the user

**Behavior**:
- Delegate requests directly to council_session
- Don't pre-analyze or filter the prompt
- Present the synthesized result verbatim — do not re-summarize or condense
- Briefly explain the consensus if requested`;

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
 * Build the synthesis prompt for the council master.
 *
 * Formats councillor results as structured data — the agent factory
 * (council-master.ts) provides the system prompt with synthesis instructions.
 * Returns a special prompt when all councillors failed to produce output.
 *
 * @param masterPrompt - Optional per-master guidance appended to the synthesis.
 */
export function formatMasterSynthesisPrompt(
  originalPrompt: string,
  councillorResults: Array<{
    name: string;
    model: string;
    status: string;
    result?: string;
    error?: string;
  }>,
  masterPrompt?: string,
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

  if (completedWithResults.length === 0) {
    return `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\nAll councillors failed to produce output. Please generate a response based on the original prompt alone.`;
  }

  let prompt = `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\n${councillorSection}`;

  if (failedSection) {
    prompt += `\n\n---\n\n**Failed/Timed-out Councillors**:\n${failedSection}`;
  }

  prompt += '\n\n---\n\nSynthesize the optimal response based on the above.';

  if (masterPrompt) {
    prompt += `\n\n---\n\n**Master Guidance**:\n${masterPrompt}`;
  }

  return prompt;
}
