import { type ToolDefinition, tool } from '@opencode-ai/plugin';

const z = tool.schema;

interface WaitForUserToolOptions {
  shouldManageSession: (sessionID: string) => boolean;
  resolveAgentName?: (agent: string) => string;
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

Use this only as the final tool action after you have already given the user concrete manual steps. The next distinct external user message resumes normal continuation. For an immediate answer, choice, clarification, or pasted output, use the question tool instead. Background tasks are not external manual work — do not use this tool to await them; the system resumes automatically via the Background Job Board and orchestrator wake scheduler.`,
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
      if (agent && agent !== 'orchestrator') {
        throw new Error('wait_for_user can only be used by orchestrator');
      }
      if (!options.shouldManageSession(sessionID)) {
        if (agent === 'orchestrator') {
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
          'Background tasks are still outstanding for this session. Do not block on manual input — end this turn now. The system resumes automatically via the Background Job Board and orchestrator wake scheduler when the background tasks complete.',
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
