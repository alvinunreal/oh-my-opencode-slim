import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { cancelTrackedExecution } from './cancel-task';
import {
  assertTaskOrchestrator,
  effectiveTaskState,
  getCurrentTrackedJob,
  relaunchInExistingSession,
  renderRelaunchOutput,
  type TaskReviveToolOptions,
} from './task-revive';

const z = tool.schema;

export type TaskSteerToolOptions = TaskReviveToolOptions;

/**
 * Steer a *running* background child: abort its current in-flight generation
 * (a turn-level interrupt — the child session and its accumulated context are
 * retained) and immediately relaunch it in the same session with a new
 * steering instruction.
 *
 * Distinct from the neighboring controls:
 * - task_message queues a non-interrupting note; a hung turn never consumes it.
 * - task_cancel stops the generation and leaves the retained session idle.
 * - task_revive resumes a retained *terminal* session; use it after a task has
 *   already ended, not to redirect one that is still running.
 */
export function createTaskSteerTool(
  options: TaskSteerToolOptions,
): Record<'task_steer', ToolDefinition> {
  const task_steer = tool({
    description:
      'Redirect a running background task: interrupt its current generation and relaunch it in the same session with a steering instruction. The session and accumulated context are retained. For a task that already finished, use task_revive instead.',
    args: {
      task_id: z
        .string()
        .describe('Tracked background task ID or Background Job Board alias'),
      prompt: z
        .string()
        .min(1)
        .describe('Steering instruction for the running task'),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertTaskOrchestrator(
        options,
        toolContext,
        'task_steer',
      );
      const requested = args.task_id.trim();
      const prompt = args.prompt.trim();
      if (!requested) throw new Error('task_steer requires task_id');
      if (!prompt) throw new Error('task_steer requires prompt');

      const resolved = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!resolved) {
        throw new Error(`Unknown or unowned background task: ${requested}`);
      }

      const current = getCurrentTrackedJob(
        options,
        parentSessionID,
        requested,
        resolved.taskID,
        resolved.generation,
      );

      if (current.state !== 'running') {
        // No-op for a finished child: there is no in-flight turn to
        // interrupt; report the state and point at task_revive instead of
        // silently reviving it (that is revive's job, with its own gate).
        const displayState = effectiveTaskState(current);
        return [
          `task_id: ${current.taskID}`,
          `generation: ${current.generation}`,
          `state: ${displayState}`,
          `status: no-op`,
          '',
          `Task is ${displayState}, not running. task_steer only interrupts a live generation; to resume a finished task in its retained session, use task_revive.`,
        ].join('\n');
      }

      // Steer = the same abort-then-reprompt sequence task_revive applies
      // to a running job: the abort is turn-level (session retained, busy
      // sessions reject promptAsync), and the relaunch starts a new
      // generation in that same session with the steering instruction.
      // The board records the interrupt as 'steered' (not 'cancelled') so
      // the audit trail stays distinct from an operator-requested cancel.
      const captured = {
        taskID: current.taskID,
        generation: current.generation,
      };
      try {
        await cancelTrackedExecution(options, captured, 'steered');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Task ${requested} could not be steered: ${message}`);
      }
      const steeredJob = getCurrentTrackedJob(
        options,
        parentSessionID,
        requested,
        captured.taskID,
        captured.generation,
      );

      // Errors from relaunch already carry the task/verb context; only
      // the cancel step gets wrapped, since its raw errors are tool-agnostic.
      const steered = await relaunchInExistingSession(options, {
        parentSessionID,
        requested,
        prompt: `The orchestrator has interrupted this task to redirect it. Steer the current work as follows:\n\n${prompt}`,
        current: steeredJob,
        verb: 'steer',
      });
      return renderRelaunchOutput(steered);
    },
  });

  return { task_steer };
}
