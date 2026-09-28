import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { JevRouter } from '../routing/jev';
import type { JevRouteResult, JevSpecialist } from '../routing/jev';

const z = tool.schema;

const SPECIALIST_VALUES = [
  'explorer',
  'librarian',
  'oracle',
  'designer',
  'fixer',
  'observer',
  'council',
  'direct',
] as const;

export interface JevRouteToolOptions {
  router: JevRouter;
  /** Optional gate: throw when the caller should not use this tool. */
  requireOrchestrator?: (agent: string | undefined) => boolean;
}

function formatResult(result: JevRouteResult): string {
  const lines: string[] = [
    `status: ${result.status}`,
    `recommendation: ${result.recommendation}`,
  ];
  if (result.specialist) lines.push(`specialist: @${result.specialist}`);
  if (result.confidence !== undefined) {
    lines.push(`confidence: ${result.confidence.toFixed(2)}`);
  }
  if (result.modelTier) lines.push(`model_tier: ${result.modelTier}`);
  if (result.model) {
    lines.push(`model: ${result.model.id}`);
    if (result.model.variant) lines.push(`variant: ${result.model.variant}`);
  }
  if (result.complexity !== undefined) {
    lines.push(`complexity: ${result.complexity}`);
  }
  if (result.risk !== undefined) lines.push(`risk: ${result.risk}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.probabilities && Object.keys(result.probabilities).length > 0) {
    const top = Object.entries(result.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(', ');
    lines.push(`top_probabilities: ${top}`);
  }
  lines.push(
    '',
    'If status is ok: prefer this specialist and use model/variant on the delegation when set.',
    'If status is low_confidence or error: keep the role-routing rules as authoritative.',
  );
  return lines.join('\n');
}

export function createJevRouteTool(
  options: JevRouteToolOptions,
): Record<'jev_route', ToolDefinition> {
  const jev_route = tool({
    description: `Ask the Jev System One decision model how to route this task (specialist + model tier). Call once before non-trivial delegation when choosing a specialist or model. Returns a typed recommendation with confidence — not a chat completion. On low_confidence or error, fall back to role routing.`,
    args: {
      task_summary: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'Compact task state: user intent, constraints, paths/areas involved. Do not paste entire files or full transcripts.',
        ),
      constraints: z
        .string()
        .max(1000)
        .optional()
        .describe('Optional hard constraints (deadline, must-not-touch, etc.).'),
      candidate_specialists: z
        .array(z.enum(SPECIALIST_VALUES))
        .optional()
        .describe(
          'Optional subset of specialists to consider. Defaults to all enabled agents plus direct.',
        ),
    },
    async execute(args, toolContext) {
      const rawAgent = toolContext?.agent;
      const agent = typeof rawAgent === 'string' ? rawAgent : undefined;
      if (
        options.requireOrchestrator &&
        !options.requireOrchestrator(agent)
      ) {
        throw new Error('jev_route can only be used by the orchestrator');
      }

      const stateParts = [args.task_summary.trim()];
      if (args.constraints?.trim()) {
        stateParts.push(`Constraints: ${args.constraints.trim()}`);
      }
      const state = stateParts.join('\n');

      const allowed = args.candidate_specialists as
        | JevSpecialist[]
        | undefined;

      const sessionID = toolContext?.sessionID;
      const result = await options.router.route({
        state,
        ...(sessionID ? { sessionID } : {}),
        ...(allowed && allowed.length > 0 ? { allowedSpecialists: allowed } : {}),
      });
      return formatResult(result);
    },
  });

  return { jev_route };
}
