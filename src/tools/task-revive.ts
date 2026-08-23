import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import type { BackgroundJobRecord } from '../utils/background-job-board';
import type { BackgroundJobSupervisor } from '../utils/background-job-supervisor';
import { getClient } from '../utils/opencode-client';
import {
  cancelTrackedExecution,
  type TaskControlToolOptions,
} from './cancel-task';

const z = tool.schema;

export interface TaskReviveToolOptions extends TaskControlToolOptions {
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  revivedRunTracker: RevivedRunTracker;
}

/**
 * Abort-then-reprompt a task inside its existing session: registers a new
 * board generation, tracks the revived run, and probes for a fast terminal.
 * Shared by task_revive (terminal retained sessions) and task_steer (running
 * tasks); the caller is responsible for the state gate and the prior cancel.
 * `verb` is the tool-facing word used in error messages ('revive'/'steer').
 */
export async function relaunchInExistingSession(
  options: TaskReviveToolOptions,
  params: {
    parentSessionID: string;
    requested: string;
    prompt: string;
    current: BackgroundJobRecord;
    verb: 'revive' | 'steer';
  },
): Promise<BackgroundJobRecord> {
  const { parentSessionID, requested, prompt, current, verb } = params;
  const revivedRunTracker = options.revivedRunTracker;
  const relaunchLease = options.backgroundJobBoard.acquireRelaunchLease(
    current.taskID,
    current.generation,
  );
  if (!relaunchLease) {
    throw new Error(
      `Task ${requested} cannot be ${verb}d: relaunch lease unavailable`,
    );
  }

  let baselineMessageID: string | undefined;
  let launched: BackgroundJobRecord | undefined;
  try {
    baselineMessageID = await revivedRunTracker.captureBaseline(current.taskID);
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
        `task_${verb} failed: ${message}`,
        launched.generation,
      );
    }
    throw new Error(`Task ${requested} ${verb} failed: ${message}`);
  } finally {
    options.backgroundJobBoard.releaseLease(relaunchLease);
  }

  if (!launched) {
    throw new Error(`Task ${requested} ${verb} did not launch`);
  }
  const latest = options.backgroundJobBoard.get(current.taskID);
  if (!latest || latest.generation !== launched.generation) {
    throw new Error(
      `Task ${requested} ${verb} became stale before launch completed`,
    );
  }
  return latest;
}

/** Display state for a board record: reconciled resolves to its terminal state. */
export function effectiveTaskState(record: BackgroundJobRecord): string {
  return record.state === 'reconciled'
    ? (record.terminalState ?? record.state)
    : record.state;
}

/** Shared rendering for revive/steer relaunch outcomes. */
export function renderRelaunchOutput(record: BackgroundJobRecord): string {
  const state = effectiveTaskState(record);
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

/** Orchestrator-only guard shared by task_revive and task_steer. */
export function assertTaskOrchestrator(
  options: TaskReviveToolOptions,
  toolContext: { sessionID?: string; agent?: string } | undefined,
  toolName: 'task_revive' | 'task_steer',
): string {
  const parentSessionID = toolContext?.sessionID;
  if (!parentSessionID) throw new Error(`${toolName} requires sessionID`);
  if (toolContext.agent && toolContext.agent !== 'orchestrator') {
    throw new Error(`${toolName} can only be used by orchestrator`);
  }
  if (!options.shouldManageSession(parentSessionID)) {
    throw new Error(`${toolName} can only be used in orchestrator sessions`);
  }
  return parentSessionID;
}

/** Freshness gate shared by task_revive and task_steer. */
export function getCurrentTrackedJob(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  requested: string,
  taskID: string,
  generation: number,
): BackgroundJobRecord {
  const current = options.backgroundJobBoard.get(taskID);
  const resolved = options.backgroundJobBoard.resolve(
    parentSessionID,
    requested,
  );
  if (!current || !resolved || resolved.taskID !== taskID) {
    throw new Error(
      `Task ${requested} is no longer tracked; refusing stale control`,
    );
  }
  if (current.generation !== generation || resolved.generation !== generation) {
    throw new Error(
      `Task ${requested} run generation changed; refusing stale control`,
    );
  }
  return current;
}

export function createTaskReviveTool(
  options: TaskReviveToolOptions,
): Record<'task_revive', ToolDefinition> {
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
      const parentSessionID = assertTaskOrchestrator(
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

      let current = getCurrentTrackedJob(
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
        current = getCurrentTrackedJob(
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

      const latest = await relaunchInExistingSession(options, {
        parentSessionID,
        requested,
        prompt,
        current,
        verb: 'revive',
      });
      return renderRelaunchOutput(latest);
    },
  });

  return { task_revive };
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
