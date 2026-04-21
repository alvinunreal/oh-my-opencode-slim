import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { CouncilManager } from '../council/council-manager';
import { shortModelLabel } from '../utils/session';

const z = tool.schema;

/**
 * Formats the model composition string for the council footer.
 * Shows short model labels per councillor: "α: gpt-5.4-mini, β: gemini-3-pro"
 */
function formatModelComposition(
  councillorResults: Array<{ name: string; model: string }>,
): string {
  return councillorResults
    .map((cr) => {
      const shortModel = shortModelLabel(cr.model);
      return `${cr.name}: ${shortModel}`;
    })
    .join(', ');
}

/**
 * Creates the council_session tool for multi-LLM orchestration.
 *
 * This tool triggers a full council session: parallel councillors →
 * formatted results returned to the council agent for synthesis.
 * Available to the council agent.
 */
export function createCouncilTool(
  _ctx: PluginInput,
  councilManager: CouncilManager,
): Record<string, ToolDefinition> {
  const council_session = tool({
    description: `Launch a multi-LLM council session for consensus-based analysis.

Sends the prompt to multiple models (councillors) in parallel and returns their formatted responses for you to synthesize.

Returns the councillor responses with a summary footer.`,
    args: {
      prompt: z.string().describe('The prompt to send to all councillors'),
      preset: z
        .string()
        .optional()
        .describe(
          'Council preset to use (default: "default"). Must match a preset in the council config.',
        ),
    },
    async execute(args, toolContext) {
      if (
        !toolContext ||
        typeof toolContext !== 'object' ||
        !('sessionID' in toolContext)
      ) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      // Guard: Only the council agent can invoke council sessions.
      // If agent is missing from context, allow through (backward compatible).
      const allowedAgents = ['council'];
      const callingAgent = (toolContext as { agent?: string }).agent;
      if (callingAgent && !allowedAgents.includes(callingAgent)) {
        throw new Error(
          `Council sessions can only be invoked by the council agent. Current agent: ${callingAgent}`,
        );
      }

      const prompt = String(args.prompt);
      const preset = typeof args.preset === 'string' ? args.preset : undefined;
      const parentSessionId = (toolContext as { sessionID: string }).sessionID;

      const result = await councilManager.runCouncil(
        prompt,
        preset,
        parentSessionId,
      );

      if (!result.success) {
        return `Council session failed: ${result.error}`;
      }

      let output = result.result ?? '(No output)';

      // Append councillor summary for transparency
      const completed = result.councillorResults.filter(
        (cr) => cr.status === 'completed',
      ).length;
      const total = result.councillorResults.length;
      const composition = formatModelComposition(result.councillorResults);

      output += `\n\n---\n*Council: ${completed}/${total} councillors responded (${composition})*`;

      // Warn about deprecated config fields if detected
      const deprecated = councilManager.getDeprecatedFields();
      if (deprecated && deprecated.length > 0) {
        output += `\n⚠ Config warning: ${deprecated.map((f) => `\`council.${f}\``).join(', ')} ${deprecated.length === 1 ? 'is' : 'are'} deprecated and ignored. The council agent synthesizes directly — remove ${deprecated.length === 1 ? 'it' : 'them'} from your config.`;
      }

      return output;
    },
  });

  return { council_session };
}
