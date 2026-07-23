import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { isRecord as isObjectRecord } from '../utils/guards';
import { log } from '../utils/logger';
import { getClient } from '../utils/opencode-client';
import { abortSessionWithTimeout, withTimeout } from '../utils/session';

const z = tool.schema;

interface CancelTaskToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  shouldManageSession: (sessionID: string) => boolean;
  abortTimeoutMs?: number;
  verifyAbortMs?: number;
  abortRetryIntervalMs?: number;
  stableStoppedMs?: number;
  deleteTimeoutMs?: number;
  deleteVerifyMs?: number;
  deleteStableStoppedMs?: number;
}

class SessionStillRunningError extends Error {}

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
      log('[cancel-task] request received', {
        parentSessionID,
        requested,
        resolvedTaskID: job?.taskID,
        alias: job
          ? options.backgroundJobBoard.field(job.taskID, 'alias')
          : undefined,
        state: job
          ? options.backgroundJobBoard.field(job.taskID, 'state')
          : undefined,
        terminalState: job
          ? options.backgroundJobBoard.field(job.taskID, 'terminalState')
          : undefined,
        cancellationRequested: job?.cancellationRequested,
      });
      if (!job) {
        if (isSessionID(requested)) {
          if (requested === parentSessionID) {
            log('[cancel-task] rejected parent session cancellation', {
              parentSessionID,
              taskID: requested,
            });
            return unknownTaskOutput(requested, 'cannot cancel parent session');
          }

          const knownJob = options.backgroundJobBoard.get(requested);
          const ownerParentSessionID =
            options.backgroundJobBoard.getParentSessionID(requested);
          if (knownJob && ownerParentSessionID !== parentSessionID) {
            log('[cancel-task] rejected unowned tracked raw session', {
              parentSessionID,
              taskID: requested,
              ownerParentSessionID,
            });
            return unknownTaskOutput(
              requested,
              'unknown or unowned background task',
            );
          }

          const parentID = await getSessionParentID(options.input, requested);
          if (parentID !== parentSessionID) {
            log('[cancel-task] rejected raw session without parent ownership', {
              parentSessionID,
              taskID: requested,
              actualParentID: parentID,
            });
            return unknownTaskOutput(
              requested,
              'unknown or unowned background task',
            );
          }

          log('[cancel-task] falling back to owned raw session abort', {
            parentSessionID,
            taskID: requested,
          });
          return cancelSessionByID(options, requested, args.reason);
        }

        return unknownTaskOutput(
          requested,
          'unknown or unowned background task',
        );
      }

      try {
        await abortAndVerifySession(options, job.taskID);
      } catch (error) {
        const stillRunning = error instanceof SessionStillRunningError;
        const boardRunning = options.backgroundJobBoard.isRunning(job.taskID);
        log('[cancel-task] abort failed', {
          taskID: job.taskID,
          stillRunning,
          boardRunning,
          error: error instanceof Error ? error.message : String(error),
        });
        options.backgroundJobBoard.updateStatus({
          taskID: job.taskID,
          state: 'running',
          statusUncertain: true,
          lastStatusError:
            error instanceof Error ? error.message : String(error),
        });
        return [
          `task_id: ${job.taskID}`,
          'state: running',
          '',
          '<task_error>',
          error instanceof Error ? error.message : String(error),
          '</task_error>',
        ].join('\n');
      }

      options.backgroundJobBoard.markCancelled(
        job.taskID,
        args.reason,
        Date.now(),
        { force: true },
      );
      const state = options.backgroundJobBoard.getState(job.taskID);
      log('[cancel-task] marked job cancelled after verified abort', {
        taskID: job.taskID,
        alias: options.backgroundJobBoard.field(job.taskID, 'alias'),
        state,
        cancellationRequested: options.backgroundJobBoard.field(
          job.taskID,
          'cancellationRequested',
        ),
      });

      return [
        `task_id: ${job.taskID}`,
        `state: ${state ?? 'cancelled'}`,
        '',
        '<task_error>',
        options.backgroundJobBoard.getResultSummary(job.taskID) ?? 'cancelled',
        '</task_error>',
      ].join('\n');
    },
  });

  return { cancel_task };
}

async function cancelSessionByID(
  options: CancelTaskToolOptions,
  taskID: string,
  reason?: string,
): Promise<string> {
  try {
    await abortAndVerifySession(options, taskID);
  } catch (error) {
    const stillRunning = error instanceof SessionStillRunningError;
    log('[cancel-task] raw session abort failed', {
      taskID,
      stillRunning,
      error: error instanceof Error ? error.message : String(error),
    });
    return [
      `task_id: ${taskID}`,
      `state: ${stillRunning ? 'running' : 'error'}`,
      '',
      '<task_error>',
      error instanceof Error ? error.message : String(error),
      '</task_error>',
    ].join('\n');
  }

  return [
    `task_id: ${taskID}`,
    'state: cancelled',
    '',
    '<task_error>',
    normalizeCancelReason(reason),
    '</task_error>',
  ].join('\n');
}

async function abortAndVerifySession(
  options: CancelTaskToolOptions,
  taskID: string,
): Promise<void> {
  log('[cancel-task] abort attempt starting', { taskID });
  const abortStartedAt = Date.now();
  try {
    // ponytail: abortSessionWithTimeout now takes v2 OpencodeClient
    await abortSessionWithTimeout(
      getClient(options.input),
      taskID,
      options.abortTimeoutMs ?? 10_000,
    );
    log('[cancel-task] abort call returned', { taskID });
  } catch (error) {
    log('[cancel-task] abort call failed', {
      taskID,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ponytail: v1 had a polling loop here that verified abort succeeded before
  // proceeding to delete. v2 abort is server-side and synchronous — the delete
  // verification loop below catches any remaining running state.
  await deleteAndVerifySession(options, taskID, 'cancel-task-after-abort');
}

async function deleteAndVerifySession(
  options: CancelTaskToolOptions,
  taskID: string,
  reason: string,
): Promise<void> {
  const v2 = getClient(options.input);

  log('[cancel-task] deleting session after unstable abort', {
    taskID,
    reason,
  });
  try {
    await withTimeout(
      v2.session.delete({
        sessionID: taskID,
        directory: options.input.directory,
      }),
      options.deleteTimeoutMs ?? 10_000,
      `Session delete timed out after ${options.deleteTimeoutMs ?? 10_000}ms`,
    );
    log('[cancel-task] session delete returned', { taskID, reason });
  } catch (error) {
    log('[cancel-task] session delete failed; verifying live state', {
      taskID,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    const status = await getSessionStatus(options.input, taskID);
    log('[cancel-task] delete failure verification status', {
      taskID,
      reason,
      status: status.status,
      statusSource: status.source,
      statusKeys: status.keys,
    });
    if (status.status === 'busy' || status.status === 'retry') {
      throw new SessionStillRunningError(
        `Session delete failed and task is still busy: ${taskID}`,
      );
    }
    if (status.status !== 'idle') throw error;
  }

  const deadline = Date.now() + (options.deleteVerifyMs ?? 1_500);
  const stableStoppedMs = options.deleteStableStoppedMs ?? 300;
  const retryIntervalMs = options.abortRetryIntervalMs ?? 150;
  let stableStoppedSince: number | undefined;
  let attempts = 0;
  let lastStatus: string | undefined;
  while (Date.now() <= deadline) {
    attempts += 1;
    const status = await getSessionStatus(options.input, taskID);
    lastStatus = status.status;
    log('[cancel-task] delete verification status', {
      taskID,
      reason,
      attempts,
      status: status.status,
      statusSource: status.source,
      statusKeys: status.keys,
      stableStoppedSince,
    });
    if (status.status === 'busy' || status.status === 'retry') {
      stableStoppedSince = undefined;
      await delay(retryIntervalMs);
      continue;
    }
    stableStoppedSince ??= Date.now();
    if (Date.now() - stableStoppedSince >= stableStoppedMs) return;
    await delay(retryIntervalMs);
  }

  throw new SessionStillRunningError(
    `Session delete returned but task did not stay stopped: ${taskID} (${lastStatus ?? 'unknown'})`,
  );
}

async function getSessionStatus(
  input: PluginInput,
  taskID: string,
): Promise<{
  status: string | undefined;
  source: string;
  keys: string[];
}> {
  try {
    const result = await getClient(input).session.status({
      directory: input.directory,
    });
    const data = result.data;
    if (!isObjectRecord(data)) {
      return { status: undefined, source: 'invalid-data', keys: [] };
    }
    const keys = Object.keys(data).slice(0, 20);
    const item = data[taskID];
    if (item === undefined) {
      return { status: 'idle', source: 'missing-from-map', keys };
    }
    if (isObjectRecord(item) && typeof item.type === 'string') {
      return { status: item.type, source: 'task-map-entry', keys };
    }
    if (typeof data.type === 'string') {
      return { status: data.type, source: 'legacy-data-type', keys };
    }
    const nested = data.status;
    if (isObjectRecord(nested) && typeof nested.type === 'string') {
      return { status: nested.type, source: 'legacy-data-status', keys };
    }
    return { status: undefined, source: 'unknown-shape', keys };
  } catch (error) {
    log('[cancel-task] session status lookup failed', {
      taskID,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: undefined, source: 'lookup-error', keys: [] };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSessionID(value: string): boolean {
  return /^ses_[\w-]+$/.test(value);
}

function normalizeCancelReason(reason?: string): string {
  const normalized = reason?.replace(/\s+/g, ' ').trim();
  return normalized ? `cancelled: ${normalized}` : 'cancelled';
}

async function getSessionParentID(
  input: PluginInput,
  taskID: string,
): Promise<string | undefined> {
  try {
    const response = await getClient(input).session.get({
      sessionID: taskID,
      directory: input.directory,
    });
    const session = response.data;
    if (!session) return undefined;
    return session.parentID;
  } catch (error) {
    log('[cancel-task] session metadata lookup failed', {
      taskID,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function unknownTaskOutput(taskID: string, message: string): string {
  return [
    `task_id: ${taskID}`,
    'state: unknown',
    '',
    '<task_error>',
    message,
    '</task_error>',
  ].join('\n');
}
