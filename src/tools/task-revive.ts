import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import type { BackgroundJobSupervisor } from '../utils/background-job-supervisor';
import { getClient } from '../utils/opencode-client';
import {
  assertOrchestrator,
  cancelTrackedExecution,
  type TaskControlToolOptions,
} from './cancel-task';

const z = tool.schema;

export interface TaskReviveToolOptions extends TaskControlToolOptions {
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  revivedRunTracker: RevivedRunTracker;
}

export function createTaskReviveTool(
  options: TaskReviveToolOptions,
): Record<'task_revive', ToolDefinition> {
  const revivedRunTracker = options.revivedRunTracker;
  const task_revive = tool({
    description:
      'Revive a retained background task in its existing session with a new prompt.',
    args: {
      task_id: z
        .string()
        .describe('Tracked background task ID or Background Job Board alias'),
      prompt: z.string().min(1).describe('Prompt for the revived task'),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertOrchestrator(
        options,
        toolContext,
        'task_revive',
      );
      const requested = args.task_id.trim();
      const prompt = args.prompt.trim();
      if (!requested) throw new Error('task_revive requires task_id');
      if (!prompt) throw new Error('task_revive requires prompt');

      const resolved = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!resolved) {
        throw new Error(`Unknown or unowned background task: ${requested}`);
      }

      let current = getCurrentReviveJob(
        options,
        parentSessionID,
        requested,
        resolved.taskID,
        resolved.generation,
      );
      const captured = {
        taskID: current.taskID,
        generation: current.generation,
      };

      let cancelledForRevive = false;
      if (current.state === 'running') {
        await cancelTrackedExecution(options, captured, 'revived');
        cancelledForRevive = true;
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          requested,
          captured.taskID,
          captured.generation,
        );
      }

      if (!cancelledForRevive && !isReviveableRetainedJob(current)) {
        throw new Error(
          `Task ${requested} cannot be revived: state ${current.state} is not a verified retained terminal session`,
        );
      }

      const relaunchLease = options.backgroundJobBoard.acquireRelaunchLease(
        current.taskID,
        current.generation,
      );
      if (!relaunchLease) {
        throw new Error(
          `Task ${requested} cannot be revived: relaunch lease unavailable`,
        );
      }

      let baselineMessageID: string | undefined;
      let launched:
        | ReturnType<
            TaskControlToolOptions['backgroundJobBoard']['registerLaunch']
          >
        | undefined;
      try {
        baselineMessageID = await revivedRunTracker.captureBaseline(
          current.taskID,
        );
        const session = getClient(options.input).session;
        if (typeof session.promptAsync !== 'function') {
          throw new Error('The host session does not support promptAsync');
        }
        const response = await session.promptAsync({
          path: { id: current.taskID },
          query: { directory: options.input.directory },
          body: {
            agent: current.agent,
            parts: [{ type: 'text', text: prompt }],
          },
        });
        const responseError = getApiError(response);
        if (responseError !== undefined) {
          throw new Error(errorText(responseError));
        }

        launched = options.backgroundJobBoard.registerLaunch({
          taskID: current.taskID,
          parentSessionID,
          agent: current.agent,
          description: current.description,
          objective: current.objective,
          background: true,
          relaunchLease,
        });
        if (launched.generation <= current.generation) {
          throw new Error(`Task ${requested} did not receive a new generation`);
        }
        revivedRunTracker.register({
          taskID: launched.taskID,
          generation: launched.generation,
          parentSessionID,
          baselineMessageID,
          description: launched.description,
        });
        options.backgroundJobSupervisor?.onLaunch(launched);
        await revivedRunTracker.probe(launched.taskID, launched.generation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (launched) {
          options.backgroundJobBoard.markStatusUncertain(
            current.taskID,
            `task_revive failed: ${message}`,
            launched.generation,
          );
        }
        throw new Error(`Task ${requested} revive failed: ${message}`);
      } finally {
        options.backgroundJobBoard.releaseLease(relaunchLease);
      }

      if (!launched) {
        throw new Error(`Task ${requested} revive did not launch`);
      }
      const latest = options.backgroundJobBoard.get(current.taskID);
      if (!latest || latest.generation !== launched.generation) {
        throw new Error(
          `Task ${requested} revive became stale before launch completed`,
        );
      }
      return renderReviveOutput(latest);
    },
  });

  return { task_revive };
}

function renderReviveOutput(
  record: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
): string {
  const state =
    record.state === 'reconciled'
      ? (record.terminalState ?? record.state)
      : record.state;
  const lines = [
    `task_id: ${record.taskID}`,
    `generation: ${record.generation}`,
    `state: ${state}`,
    `status: ${state === 'running' ? 'started' : state}`,
  ];
  if (record.resultSummary !== undefined) {
    const tag = state === 'completed' ? 'task_result' : 'task_error';
    lines.push('', `<${tag}>`, record.resultSummary, `</${tag}>`);
  }
  return lines.join('\n');
}

function getCurrentReviveJob(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  requested: string,
  taskID: string,
  generation: number,
): NonNullable<ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>> {
  const current = options.backgroundJobBoard.get(taskID);
  const resolved = options.backgroundJobBoard.resolve(
    parentSessionID,
    requested,
  );
  if (!current || !resolved || resolved.taskID !== taskID) {
    throw new Error(
      `Task ${requested} is no longer tracked; refusing stale revive`,
    );
  }
  if (current.generation !== generation || resolved.generation !== generation) {
    throw new Error(
      `Task ${requested} run generation changed; refusing stale revive`,
    );
  }
  return current;
}

function isReviveableRetainedJob(
  job: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
): boolean {
  if (job.statusUncertain) return false;
  if (
    job.state === 'completed' ||
    job.state === 'error' ||
    job.state === 'cancelled'
  ) {
    return true;
  }
  return job.state === 'reconciled' && job.terminalState !== undefined;
}

function getApiError(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined;
  const record = response as Record<string, unknown>;
  return record.error === undefined || record.error === null
    ? undefined
    : record.error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
