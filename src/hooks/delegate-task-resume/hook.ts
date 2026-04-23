import type { PluginInput } from '@opencode-ai/plugin';
import type { TaskSessionTracker } from '../../utils/task-session-tracker';
import { detectInterruptedTask, parseTaskId } from './detector';
import { buildResumeGuidance } from './guidance';

export function createDelegateTaskResumeHook(
  _ctx: PluginInput,
  sessionTracker: TaskSessionTracker,
) {
  return {
    'tool.execute.after': async (
      input: { tool: string },
      output: { output: unknown },
    ): Promise<void> => {
      const toolName = input.tool.toLowerCase();
      if (toolName !== 'task') return;

      if (typeof output.output !== 'string') return;

      const taskOutput = output.output as string;

      // Try to extract the subagent session ID from the tool output.
      // This is the session ID that can be passed as task_id to resume.
      const taskId = parseTaskId(taskOutput);

      // Detect empty/interrupted results (not parameter errors)
      if (!detectInterruptedTask(taskOutput)) {
        // Successful result — mark the subagent session as completed if tracked
        if (taskId) {
          sessionTracker.markCompleted(taskId);
        }
        return;
      }

      // We have an interrupted/empty result.
      // We need taskId to build the recovery note — without it we cannot
      // identify which subagent session this refers to.
      if (!taskId) return;

      // Mark as interrupted in the tracker
      sessionTracker.markInterrupted(taskId);

      // Look up session info for the recovery note (agent name, etc.)
      const sessionInfo = sessionTracker.get(taskId);

      const guidance = buildResumeGuidance({
        sessionId: taskId,
        agent: sessionInfo?.agent,
        status: sessionInfo?.status ?? 'interrupted',
      });

      if (guidance) {
        output.output += guidance;
      }
    },
  };
}
