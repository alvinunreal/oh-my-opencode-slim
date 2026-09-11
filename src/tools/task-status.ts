import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import { observationFromSnapshot, summarizeTaskStatus } from './task-policy';

const z = tool.schema;
const ACTIVE_STATES = new Set(['busy', 'running', 'retry']);

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
  statusTimeoutMs?: number;
}): Record<'task_status', ToolDefinition> {
  const task_status = tool({
    description:
      'Read the current status of a tracked child task without resuming, prompting, or changing it. Accepts its task ID or parent-scoped alias.',
    args: {
      task_id: z.string().describe('Tracked task ID or parent-scoped alias'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_status requires task_id');

      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!job) throw new Error(`Unknown task ID or alias: ${requested}`);

      // Bounded live read: a failed, malformed, or timed-out host status
      // response surfaces as explicit uncertainty instead of a confident
      // board-state fallback.
      const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
        timeoutMs: options.statusTimeoutMs,
      });
      const observation = observationFromSnapshot(snapshot, job.taskID);
      const now = options.now?.() ?? Date.now();
      const lastActivityAt =
        options.activityTracker?.lastActivityAt(job.taskID) ??
        job.lastLiveBusyAt ??
        job.runStartedAt;
      const report = summarizeTaskStatus(job, observation, lastActivityAt, now);

      const details = [
        `Task ${job.alias} (${job.taskID})`,
        `state: ${report.state}${report.uncertain ? ' (unconfirmed)' : ''}`,
        `agent: ${job.agent}`,
        `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
        `idle_for_seconds: ${report.idleSeconds}`,
        `possibly_stuck: ${report.possiblyStuck}`,
      ];
      if (report.uncertain) {
        details.push('status_uncertain: true');
        if (report.lastStatusError) {
          details.push(`last_status_error: ${report.lastStatusError}`);
        }
      }
      if (!report.uncertain && ACTIVE_STATES.has(report.state)) {
        details.push('');
        details.push(
          '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
        );
      }
      return details.join('\n');
    },
  });

  return { task_status };
}
