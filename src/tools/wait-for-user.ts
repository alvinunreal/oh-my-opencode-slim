import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { isBuiltInPrimaryAgent } from '../utils/agent-variant';

const z = tool.schema;

interface WaitForUserToolOptions {
  shouldManageSession: (sessionID: string) => boolean;
  resolveAgentName?: (agent: string) => string;
  /** Primary classification (issue #1591); defaults to built-in only. */
  isPrimaryAgentName?: (agent: string) => boolean;
  registerSessionAsOrchestrator?: (sessionID: string) => void;
  beginUserWait: (sessionID: string) => void;
  hasOutstandingBackgroundTasks?: (sessionID: string) => boolean;
  waitForUserGuardEnabled?: boolean;
}

export function createWaitForUserTool(
  options: WaitForUserToolOptions,
): Record<'wait_for_user', ToolDefinition> {
  const wait_for_user = tool({
    description: `Pause automatic continuation while waiting for external human action.

Final tool action only, after giving the user concrete manual steps; the next distinct external user message resumes continuation. For an immediate answer or choice, use the question tool instead. Not for awaiting background tasks — the system resumes automatically via the completion notice and wake scheduler.`,
    args: {
      reason: z
        .string()
        .min(1)
        .max(500)
        .describe(
          'Short description of the external human action being awaited',
        ),
    },
    async execute(args, toolContext) {
      const sessionID = toolContext?.sessionID;
      if (!sessionID) throw new Error('wait_for_user requires sessionID');
      const rawAgent = toolContext?.agent;
      const agent =
        typeof rawAgent === 'string'
          ? (options.resolveAgentName?.(rawAgent) ?? rawAgent)
          : undefined;
      const isPrimary = options.isPrimaryAgentName ?? isBuiltInPrimaryAgent;
      if (agent && !isPrimary(agent)) {
        throw new Error(
          'wait_for_user can only be used by primary orchestrators',
        );
      }
      if (!options.shouldManageSession(sessionID)) {
        if (agent && isPrimary(agent)) {
          options.registerSessionAsOrchestrator?.(sessionID);
        }
      }
      if (!options.shouldManageSession(sessionID)) {
        throw new Error(
          'wait_for_user can only be used in orchestrator sessions',
        );
      }

      const reason = args.reason.replace(/\s+/g, ' ').trim();
      if (!reason) throw new Error('wait_for_user requires a non-empty reason');

      if (
        options.waitForUserGuardEnabled &&
        options.hasOutstandingBackgroundTasks?.(sessionID)
      ) {
        return [
          'state: waiting_for_user_skipped',
          `reason: ${reason}`,
          '',
          'Background tasks are still outstanding for this session. Do not block on manual input — end this turn now. The system resumes automatically via the completion notice and orchestrator wake scheduler when the background tasks complete.',
        ].join('\n');
      }

      options.beginUserWait(sessionID);
      return [
        'state: waiting_for_user',
        'protocol: oh-my-opencode-slim.wait_for_user.v1',
        `reason: ${reason}`,
        '',
        'End this turn now. Do not call more tools until the user responds.',
      ].join('\n');
    },
  });

  return { wait_for_user };
}
