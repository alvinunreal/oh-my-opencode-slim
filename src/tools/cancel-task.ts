import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobBoard } from '../utils/background-job-board';
import { isRecord as isObjectRecord } from '../utils/guards';
import { log } from '../utils/logger';
import { abortSessionWithTimeout, withTimeout } from '../utils/session';

const z = tool.schema;

interface CancelTaskToolOptions {
  client: PluginInput['client'];
  backgroundJobBoard: BackgroundJobBoard;
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

          const parentID = await getSessionParentID(options.client, requested);
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
    await abortSessionWithTimeout(
      options.client,
      taskID,
      options.abortTimeoutMs ?? 10_000,
    );
    log('[cancel-task] abort call returned', { taskID });
  } catch (error) {
    log('[cancel-task] abort call failed', {
      taskID,
      error: error instanceof Error ? error.message : String(error),
      canDelete: canDeleteSession(options.client),
    });
    if (!canDeleteSession(options.client)) throw error;
  }

  if (canDeleteSession(options.client)) {
    await deleteAndVerifySession(options, taskID, 'cancel-task-after-abort');
    return;
  }

  const verifyAbortMs = options.verifyAbortMs ?? 8_000;
  const stableStoppedMs = options.stableStoppedMs ?? 3_000;
  const retryIntervalMs = options.abortRetryIntervalMs ?? 150;
  const deadline = Date.now() + verifyAbortMs;
  log('[cancel-task] abort verification starting', {
    taskID,
    verifyAbortMs,
    stableStoppedMs,
    retryIntervalMs,
  });
  let attempts = 0;
  let stableStoppedSince: number | undefined;
  let lastStatus: string | undefined;
  while (Date.now() <= deadline) {
    attempts += 1;
    const statusSnapshot = await getSessionStatus(options.client, taskID);
    lastStatus = statusSnapshot.status;
    log('[cancel-task] abort verification status', {
      taskID,
      attempts,
      status: statusSnapshot.status,
      statusSource: statusSnapshot.source,
      statusKeys: statusSnapshot.keys,
      stableStoppedSince,
      stableStoppedForMs: stableStoppedSince
        ? Date.now() - stableStoppedSince
        : 0,
      boardState: options.backgroundJobBoard.getState(taskID),
      boardLastLiveBusyAt: options.backgroundJobBoard.getLastLiveBusyAt(taskID),
    });
    const boardLastLiveBusyAt =
      options.backgroundJobBoard.getLastLiveBusyAt(taskID);
    if (boardLastLiveBusyAt && boardLastLiveBusyAt >= abortStartedAt) {
      log('[cancel-task] abort verification saw board busy after abort', {
        taskID,
        attempts,
        abortStartedAt,
        boardLastLiveBusyAt,
        status: statusSnapshot.status,
        statusSource: statusSnapshot.source,
      });
      await deleteAndVerifySession(options, taskID, 'board-busy-after-abort');
      return;
    }
    if (statusSnapshot.status === 'busy' || statusSnapshot.status === 'retry') {
      if (stableStoppedSince !== undefined) {
        log('[cancel-task] abort verification saw busy after idle', {
          taskID,
          attempts,
          stableStoppedForMs: Date.now() - stableStoppedSince,
        });
        await deleteAndVerifySession(options, taskID, 'busy-after-idle');
        return;
      }
      stableStoppedSince = undefined;
      await abortSessionWithTimeout(
        options.client,
        taskID,
        options.abortTimeoutMs ?? 10_000,
      );
      log('[cancel-task] abort retry returned', {
        taskID,
        attempts,
        status: statusSnapshot.status,
      });
      await delay(retryIntervalMs);
      continue;
    }

    stableStoppedSince ??= Date.now();
    if (Date.now() - stableStoppedSince >= stableStoppedMs) {
      log('[cancel-task] abort verified stopped', {
        taskID,
        attempts,
        status: statusSnapshot.status,
        stableStoppedMs,
      });
      return;
    }

    await delay(retryIntervalMs);
  }

  log('[cancel-task] abort verification timed out', {
    taskID,
    attempts,
    lastStatus,
    stableStoppedSince,
  });
  if (lastStatus === 'busy' || lastStatus === 'retry') {
    await deleteAndVerifySession(options, taskID, 'still-busy-after-abort');
    return;
  }
  throw new SessionStillRunningError(
    `Session abort returned but task did not stay stopped: ${taskID}`,
  );
}

async function deleteAndVerifySession(
  options: CancelTaskToolOptions,
  taskID: string,
  reason: string,
): Promise<void> {
  const session = options.client.session as unknown as {
    delete?: (args: { path: { id: string } }) => Promise<unknown>;
  };
  if (!session.delete) {
    log('[cancel-task] session delete unavailable', { taskID, reason });
    throw new SessionStillRunningError(
      `Session resumed after abort and delete is unavailable: ${taskID}`,
    );
  }

  log('[cancel-task] deleting session after unstable abort', {
    taskID,
    reason,
  });
  try {
    await withTimeout(
      session.delete({ path: { id: taskID } }),
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
    const status = await getSessionStatus(options.client, taskID);
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
    const status = await getSessionStatus(options.client, taskID);
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

function canDeleteSession(client: PluginInput['client']): boolean {
  const session = client.session as unknown as { delete?: unknown };
  return typeof session.delete === 'function';
}

async function getSessionStatus(
  client: PluginInput['client'],
  taskID: string,
): Promise<{
  status: string | undefined;
  source: string;
  keys: string[];
}> {
  try {
    const result = await (
      client.session.status as unknown as () => Promise<unknown>
    )();
    const data = (result as { data?: unknown }).data;
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
  client: PluginInput['client'],
  taskID: string,
): Promise<string | undefined> {
  const session = client.session as unknown as {
    get?: (args: { path: { id: string } }) => Promise<unknown>;
  };
  if (!session.get) return undefined;
  try {
    const response = await session.get({ path: { id: taskID } });
    const data = (response as { data?: unknown }).data;
    if (!isObjectRecord(data)) return undefined;
    const parentID = data.parentID;
    return typeof parentID === 'string' ? parentID : undefined;
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
