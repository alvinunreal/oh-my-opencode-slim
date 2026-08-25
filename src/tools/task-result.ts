import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobRecord } from '../utils/background-job-board';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getClient } from '../utils/opencode-client';
import {
  extractFinalSessionResult,
  SESSION_ID_PATTERN,
} from '../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';

const z = tool.schema;

interface TaskResultToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
}

/**
 * Gate tracked task retrieval on the tracked terminal outcome. Only a
 * `completed` state (or a reconciled job whose terminal outcome was
 * `completed`) may yield a successful result. Errored, cancelled and otherwise
 * unconfirmed jobs are rejected instead of leaking partial output as a final
 * result.
 */
function assertRetrievableState(
  requested: string,
  job: BackgroundJobRecord,
): void {
  const terminalState = getTrackedTerminalState(job);

  if (terminalState === 'running') return;
  if (terminalState === 'error') {
    throw new Error(
      `Task ${requested} ended in error: ${job.lastStatusError ?? job.resultSummary ?? 'no error details available'}`,
    );
  }
  if (terminalState === 'cancelled') {
    const reason = job.resultSummary?.replace(/^cancelled:\s*/i, '');
    throw new Error(
      `Task ${requested} was cancelled${reason ? `: ${reason}` : ''}`,
    );
  }
  if (terminalState !== 'completed') {
    throw new Error(`Task ${requested} has no confirmed completed result`);
  }
}

function getTrackedTerminalState(
  job: BackgroundJobRecord,
): BackgroundJobRecord['state'] | BackgroundJobRecord['terminalState'] {
  return job.state === 'reconciled' ? job.terminalState : job.state;
}

function formatRunningTaskStatus(
  taskID: string,
  state: 'running' | 'retry',
  tracked: boolean,
): string {
  return [
    `task_id: ${taskID}`,
    `state: ${state}`,
    'message: Task is still running. Wait for its terminal result.',
    `next: ${tracked ? 'use task_status to inspect the task' : 'retry task_result after the task finishes'}`,
  ].join('\n');
}

function assertStableTrackedGeneration(
  requested: string,
  parentSessionID: string,
  expectedTaskID: string,
  expectedGeneration: number,
  backgroundJobBoard: BackgroundJobStore,
): BackgroundJobRecord {
  const current = backgroundJobBoard.resolve(parentSessionID, requested);
  if (
    !current ||
    current.taskID !== expectedTaskID ||
    current.generation !== expectedGeneration
  ) {
    if (current) assertRetrievableState(requested, current);
    throw new Error(
      `Task ${requested} changed generation while its result was being retrieved; wait for its current terminal result instead of retrieving it.`,
    );
  }

  // A retrieval attempt on a terminal job counts as consuming its state,
  // even when the retrieval below is refused (error/cancelled/stopped with
  // no result text). This opens the duplicate-spawn guard's escape hatch for
  // failed terminals: the caller saw the terminal outcome, so re-dispatch is
  // authorized. Running jobs are never acked here.
  if (getTrackedTerminalState(current) !== 'running') {
    backgroundJobBoard.markUsed(parentSessionID, current.taskID);
  }

  assertRetrievableState(requested, current);
  return current;
}

export function createTaskResultTool(
  options: TaskResultToolOptions,
): Record<string, ToolDefinition> {
  const task_result = tool({
    description: `Retrieve the final text already produced by a specialist task, or inspect its active state without resuming or re-running it.

Use this when the user asks to see a prior task's full result, or before retrying work whose completed output may already answer the request. If the task is still running, this returns a status message; only a completed task returns its final text. Accepts either the native task_id/session ID or the parent-scoped alias shown in the Background Job Board. This tool is read-only and never sends a new prompt to the specialist.`,
    args: {
      task_id: z.string().describe('Task ID or Background Job Board alias'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_result requires sessionID');
      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_result requires task_id');

      let tracked = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      const trackedTaskID = tracked?.taskID;
      const trackedGeneration = tracked?.generation;

      const revalidateTracked = (): void => {
        if (trackedTaskID === undefined || trackedGeneration === undefined) {
          return;
        }
        tracked = assertStableTrackedGeneration(
          requested,
          parentSessionID,
          trackedTaskID,
          trackedGeneration,
          options.backgroundJobBoard,
        );
      };

      // A stopped board record is only a provisional observation. Re-check the
      // live runner once, with the same bounded status path used elsewhere,
      // before rejecting it. A busy/retry observation self-heals that record
      // and prevents a stale stopped gate from hiding a still-live task.
      let liveSnapshot: RuntimeSessionStatusSnapshot | undefined;
      if (tracked?.state === 'stopped') {
        liveSnapshot = await getRuntimeSessionStatusSnapshot(options.input);
        const liveStatus = runtimeSessionStatus(liveSnapshot, tracked.taskID);
        if (liveStatus === 'busy' || liveStatus === 'retry') {
          options.backgroundJobBoard.markRunningFromLiveSession(
            tracked.taskID,
            Date.now(),
            tracked.generation,
          );
          tracked = options.backgroundJobBoard.resolve(
            parentSessionID,
            requested,
          );
        }
      }

      revalidateTracked();

      const taskID = tracked?.taskID ?? requested;
      if (!SESSION_ID_PATTERN.test(taskID)) {
        throw new Error(`Unknown task ID or alias: ${requested}`);
      }

      if (tracked && getTrackedTerminalState(tracked) === 'running') {
        liveSnapshot ??= await getRuntimeSessionStatusSnapshot(options.input);
        revalidateTracked();
        if (tracked && getTrackedTerminalState(tracked) === 'running') {
          const status = runtimeSessionStatus(liveSnapshot, taskID);
          return formatRunningTaskStatus(
            taskID,
            status === 'retry' ? 'retry' : 'running',
            true,
          );
        }
      }

      const client = getClient(options.input);
      const sessionClient = client.session as typeof client.session & {
        get?: typeof client.session.get;
      };
      if (sessionClient.get) {
        const session = await sessionClient.get({
          path: { id: taskID },
          query: { directory: options.input.directory },
        });
        const info = session.data as { parentID?: string } | undefined;
        if (info?.parentID !== parentSessionID) {
          throw new Error(`Task ${requested} does not belong to this session`);
        }
      } else if (!tracked) {
        throw new Error(
          `Task ${requested} is not tracked by this session and cannot be verified`,
        );
      }

      revalidateTracked();
      liveSnapshot ??= await getRuntimeSessionStatusSnapshot(options.input);
      revalidateTracked();
      const status = runtimeSessionStatus(liveSnapshot, taskID);
      const trackedTerminalState = tracked
        ? getTrackedTerminalState(tracked)
        : undefined;
      const activeState =
        status === 'retry'
          ? 'retry'
          : status === 'busy' || trackedTerminalState === 'running'
            ? 'running'
            : undefined;
      if (activeState !== undefined && trackedTerminalState !== 'completed') {
        return formatRunningTaskStatus(
          taskID,
          activeState,
          tracked !== undefined,
        );
      }

      if (!sessionClient.get) {
        const result = tracked?.resultSummary?.trim();
        if (!result) {
          throw new Error(`Task ${requested} has no completed text result`);
        }
        options.backgroundJobBoard.markUsed(parentSessionID, taskID);
        return result;
      }

      revalidateTracked();
      const result = await extractFinalSessionResult(client, taskID, {
        directory: options.input.directory,
        includeReasoning: false,
      });
      revalidateTracked();
      if (result.empty) {
        throw new Error(`Task ${requested} has no completed text result`);
      }
      if (!tracked && result.terminal !== true) {
        throw new Error(
          `Task ${requested} shows no terminal evidence of completion; refusing to present partial output as its final result`,
        );
      }

      options.backgroundJobBoard.markUsed(parentSessionID, taskID);
      return result.text;
    },
  });

  return { task_result };
}
