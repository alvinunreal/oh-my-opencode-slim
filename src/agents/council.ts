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
4. Follow the Synthesis Process below
5. Present the result to the user

**Synthesis Process** (MANDATORY — follow in order):
1. Read the original user prompt
2. Review each councillor's response individually — note each councillor's \
key insight and unique contribution by name
3. Identify agreements and contradictions between councillors
4. Resolve contradictions with explicit reasoning
5. Synthesize the optimal final answer
6. Format output per the Required Output Format below

**Behavior**:
- Delegate requests directly to council_session
- Don't pre-analyze or filter the prompt before calling council_session
- Credit specific insights from individual councillors using their names
- If councillors disagree, explain why you chose one approach over another
- Do not omit per-councillor details from the final response
- Do not collapse the output into only a final summary
- Be transparent about trade-offs when different approaches have valid pros/cons
- Don't just average responses — choose the best approach and improve upon it

**Required Output Format**:
Always include these sections in your final response:

## Council Response
Provide the best synthesized answer. Integrate the strongest points from the \
councillors, resolve disagreements, and give the user a clear final \
recommendation or answer. Include relevant code examples and concrete details.

## Councillor Details
Include each councillor's response separately.

Use each councillor name exactly as provided in the tool result.

Format each councillor like:

### <councillor name>
<that councillor's response>

If a councillor failed or timed out, include that status briefly.

## Council Summary
Summarize where councillors agreed, where they disagreed, why you chose the \
final answer, and any remaining uncertainty. Include a consensus confidence \
rating: unanimous, majority, or split.`;

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
          `**${cr.name}** (${shortModelLabel(cr.model)}): ${cr.status} — ${
            cr.error ?? 'Unknown'
          }`,
      )
      .join('\n');

    return `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\nAll councillors failed to produce output:\n${errorDetails}\n\nPlease generate a response based on the original prompt alone.`;
  }

  let prompt = `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\n${councillorSection}`;

  if (failedSection) {
    prompt += `\n\n---\n\n**Failed/Timed-out Councillors**:\n${failedSection}`;
  }

  prompt +=
    '\n\n---\n\nYou MUST follow the Synthesis Process steps before producing output: review each councillor response individually, then produce the required output with a synthesized Council Response, per-councillor details using their exact names, and a Council Summary with consensus confidence rating (unanimous, majority, or split).';

  return prompt;
}
