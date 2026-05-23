import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobBoard } from '../utils/background-job-board';
import {
  abortSessionWithTimeout,
  OperationTimeoutError,
} from '../utils/session';

const z = tool.schema;

interface CancelTaskToolOptions {
  client: PluginInput['client'];
  backgroundJobBoard: BackgroundJobBoard;
  shouldManageSession: (sessionID: string) => boolean;
  abortTimeoutMs?: number;
}

export function createCancelTaskTool(
  options: CancelTaskToolOptions,
): Record<string, ToolDefinition> {
  const cancel_task = tool({
    description: `Cancel a tracked background specialist task.

Use only for obsolete, wrong, conflicting, or user-requested cancellation. Accepts either the native task_id/session ID or the parent-scoped alias shown in the Background Job Board. Cancellation is not rollback: if cancelling a writer, inspect and reconcile partial file changes before replacing the lane.`,
    args: {
      task_id: z
        .string()
        .describe('Tracked background task ID or Background Job Board alias'),
      reason: z.string().optional().describe('Short cancellation reason'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('cancel_task requires sessionID');
      if (toolContext.agent && toolContext.agent !== 'orchestrator') {
        throw new Error('cancel_task can only be used by orchestrator');
      }
      if (!options.shouldManageSession(parentSessionID)) {
        throw new Error(
          'cancel_task can only be used in orchestrator sessions',
        );
      }

      const requested = args.task_id.trim();
      if (!requested) throw new Error('cancel_task requires task_id');

      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!job) {
        return [
          `task_id: ${requested}`,
          'state: unknown',
          '',
          '<task_error>',
          'unknown or unowned background task',
          '</task_error>',
        ].join('\n');
      }

      const shouldAbort =
        job.state === 'running' ||
        job.state === 'cancelled' ||
        (job.state === 'reconciled' && job.terminalState === 'cancelled');

      if (!shouldAbort) {
        return [
          `task_id: ${job.taskID}`,
          `state: ${job.state}`,
          '',
          '<task_result>',
          `not cancelled: task is already ${job.state}`,
          '</task_result>',
        ].join('\n');
      }

      try {
        await abortSessionWithTimeout(
          options.client,
          job.taskID,
          options.abortTimeoutMs ?? 10_000,
        );
      } catch (error) {
        const timedOut = error instanceof OperationTimeoutError;
        if (timedOut) {
          options.backgroundJobBoard.updateStatus({
            taskID: job.taskID,
            state: 'error',
            resultSummary:
              error instanceof Error
                ? error.message
                : 'cancel request timed out',
          });
        }
        return [
          `task_id: ${job.taskID}`,
          `state: ${timedOut ? 'error' : 'cancel_error'}`,
          '',
          '<task_error>',
          error instanceof Error ? error.message : String(error),
          '</task_error>',
        ].join('\n');
      }

      const cancelled = options.backgroundJobBoard.markCancelled(
        job.taskID,
        args.reason,
      );

      return [
        `task_id: ${job.taskID}`,
        `state: ${cancelled?.state ?? 'cancelled'}`,
        '',
        '<task_error>',
        cancelled?.resultSummary ?? 'cancelled',
        '</task_error>',
      ].join('\n');
    },
  });

  return { cancel_task };
}
