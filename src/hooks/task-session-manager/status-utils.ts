import type {
  BackgroundJobRecord,
  BackgroundJobStore,
  ContextFile,
} from '../../utils';
import { guardCompletedStatusText, parseTaskStatusOutput } from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';

export function extractTaskSummary(output: string): string | undefined {
  const summary = /<summary>\s*([\s\S]*?)\s*<\/summary>/i.exec(output)?.[1];
  return summary?.trim() || undefined;
}

export function isActiveStatus(
  status: Record<string, unknown>,
  sessionID: string,
): boolean {
  return Object.hasOwn(status, sessionID);
}

export function isLateCancelledTaskError(
  job: BackgroundJobRecord | undefined,
  state: string,
): boolean {
  if (state !== 'error') return false;
  if (!job?.cancellationRequested) return false;
  return job.state === 'cancelled' || job.terminalState === 'cancelled';
}

export function formatCancelledTaskStatusOutput(
  taskID: string,
  summary = 'cancelled',
): string {
  return [
    `task_id: ${taskID}`,
    'state: cancelled',
    '',
    '<task_error>',
    summary,
    '</task_error>',
  ].join('\n');
}

export function updateBackgroundJobFromOutput(
  output: unknown,
  backgroundJobBoard: BackgroundJobStore,
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  },
): BackgroundJobRecord | undefined {
  if (typeof output !== 'string') return undefined;

  const status = parseTaskStatusOutput(output);
  if (!status) return undefined;

  log('[task-session-manager] parsed task output status', {
    taskID: status.taskID,
    state: status.state,
    timedOut: status.timedOut,
    hasResult: Boolean(status.result),
  });

  const existing = backgroundJobBoard.get(status.taskID);
  if (isLateCancelledTaskError(existing, status.state)) {
    log('[task-session-manager] suppressed late cancelled task error', {
      taskID: status.taskID,
      alias: existing?.alias,
      parsedState: status.state,
      boardState: existing?.state,
      terminalState: existing?.terminalState,
      result: status.result,
    });
    return existing;
  }

  const guarded = guardCompletedStatusText(
    status.state,
    status.result,
    existing?.resultSummary,
  );

  const updated = backgroundJobBoard.updateStatus({
    taskID: status.taskID,
    state: guarded.state,
    timedOut: status.timedOut,
    resultSummary: guarded.resultSummary,
    lastStatusError: guarded.lastStatusError,
  });
  if (!updated) {
    log('[task-session-manager] ignored status for unknown background job', {
      taskID: status.taskID,
      state: status.state,
    });
    return undefined;
  }

  log('[task-session-manager] background job status updated', {
    taskID: updated.taskID,
    alias: updated.alias,
    parentSessionID: updated.parentSessionID,
    state: updated.state,
    terminalUnreconciled: updated.terminalUnreconciled,
    timedOut: updated.timedOut,
  });

  if (backgroundJobBoard.isTerminalUnreconciled(updated.taskID)) {
    taskContextTracker.pendingManagedTaskIds.delete(updated.taskID);
    backgroundJobBoard.addContext(
      updated.taskID,
      taskContextTracker.contextFilesForPrompt(updated.taskID),
    );
    taskContextTracker.prune(backgroundJobBoard);
  }

  return updated;
}

export function normalizeLateCancelledTaskOutput(
  output: { output: unknown; metadata?: unknown },
  backgroundJobBoard: BackgroundJobStore,
): void {
  if (typeof output.output !== 'string') return;
  const status = parseTaskStatusOutput(output.output);
  if (!status) return;
  const existing = backgroundJobBoard.get(status.taskID);
  if (!isLateCancelledTaskError(existing, status.state)) return;
  log('[task-session-manager] normalized late cancelled task output', {
    taskID: status.taskID,
    alias: existing?.alias,
    state: existing?.state,
    terminalState: existing?.terminalState,
    result: status.result,
  });
  output.output = formatCancelledTaskStatusOutput(
    status.taskID,
    backgroundJobBoard.getResultSummary(status.taskID),
  );
  if (isObjectRecord(output) && isObjectRecord(output.metadata)) {
    output.metadata.state = 'cancelled';
  }
}
