import type { PluginInput } from '@opencode-ai/plugin';
import type { AgentName } from '../../config';
import {
  deriveTaskSessionLabel,
  parseTaskIdFromTaskOutput,
  SessionManager,
} from '../../utils';

interface TaskArgs {
  description?: unknown;
  prompt?: unknown;
  subagent_type?: unknown;
  task_id?: unknown;
}

interface PendingTaskCall {
  parentSessionId: string;
  agentType: AgentName;
  label: string;
  resumedTaskId?: string;
}

const AGENT_NAME_SET = new Set<AgentName>([
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
  'observer',
  'council',
  'councillor',
]);

function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && AGENT_NAME_SET.has(value as AgentName);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createTaskSessionManagerHook(
  _ctx: PluginInput,
  options: {
    maxSessionsPerAgent: number;
    shouldManageSession: (sessionID: string) => boolean;
  },
) {
  const sessionManager = new SessionManager(options.maxSessionsPerAgent);
  const pendingCalls = new Map<string, PendingTaskCall>();

  function isMissingRememberedSessionError(output: string): boolean {
    const normalized = output.toLowerCase();
    return (
      normalized.includes('session') &&
      (normalized.includes('not found') || normalized.includes('no session'))
    );
  }

  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'task') return;
      if (!input.sessionID || !options.shouldManageSession(input.sessionID)) {
        return;
      }
      if (!isObjectRecord(output.args)) return;

      const args = output.args as TaskArgs;
      if (!isAgentName(args.subagent_type)) return;

      const label = deriveTaskSessionLabel({
        description:
          typeof args.description === 'string' ? args.description : undefined,
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        agentType: args.subagent_type,
      });

      if (input.callID) {
        pendingCalls.set(input.callID, {
          parentSessionId: input.sessionID,
          agentType: args.subagent_type,
          label,
        });
      }

      if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
        return;
      }

      const requested = args.task_id.trim();
      const remembered = sessionManager.resolve(
        input.sessionID,
        args.subagent_type,
        requested,
      );

      if (!remembered) {
        delete args.task_id;
        return;
      }

      args.task_id = remembered.taskId;
      sessionManager.markUsed(
        input.sessionID,
        args.subagent_type,
        remembered.taskId,
      );
      if (input.callID) {
        pendingCalls.set(input.callID, {
          parentSessionId: input.sessionID,
          agentType: args.subagent_type,
          label,
          resumedTaskId: remembered.taskId,
        });
      }
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown },
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'task') return;

      const pending = input.callID ? pendingCalls.get(input.callID) : undefined;
      if (input.callID) {
        pendingCalls.delete(input.callID);
      }

      if (!pending || typeof output.output !== 'string') return;
      const taskId = parseTaskIdFromTaskOutput(output.output);
      if (!taskId) {
        if (
          pending.resumedTaskId &&
          isMissingRememberedSessionError(output.output)
        ) {
          sessionManager.drop(
            pending.parentSessionId,
            pending.agentType,
            pending.resumedTaskId,
          );
        }
        return;
      }

      sessionManager.remember({
        parentSessionId: pending.parentSessionId,
        taskId,
        agentType: pending.agentType,
        label: pending.label,
      });
    },

    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      if (!input.sessionID || !options.shouldManageSession(input.sessionID)) {
        return;
      }

      const reminder = sessionManager.formatForPrompt(input.sessionID);
      if (!reminder) return;
      output.system.push(reminder);
    },

    event: async (input: {
      event: {
        type: string;
        properties?: { info?: { id?: string }; sessionID?: string };
      };
    }): Promise<void> => {
      if (input.event.type !== 'session.deleted') return;
      const sessionId =
        input.event.properties?.info?.id ?? input.event.properties?.sessionID;
      if (!sessionId) return;

      sessionManager.clearParent(sessionId);
      sessionManager.dropTask(sessionId);
    },
  };
}
