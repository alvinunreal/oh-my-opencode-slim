import type {
  BackgroundJobLifecycle,
  BackgroundJobRecord,
} from '../../background-jobs';
import { parseTaskStatusOutput } from '../../utils';
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
  idParam = 'task_id',
): string {
  return [
    `${idParam}: ${taskID}`,
    'state: cancelled',
    '',
    '<task_error>',
    summary,
    '</task_error>',
  ].join('\n');
}

export function normalizeLateCancelledTaskOutput(
  output: { output: unknown; metadata?: unknown },
  backgroundJobs: BackgroundJobLifecycle,
  idParam = 'task_id',
): void {
  if (typeof output.output !== 'string') return;
  const status = parseTaskStatusOutput(output.output);
  if (!status) return;
  const existing = backgroundJobs.get(status.taskID);
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
    backgroundJobs.getResultSummary(status.taskID),
    idParam,
  );
  if (isObjectRecord(output) && isObjectRecord(output.metadata)) {
    output.metadata.state = 'cancelled';
  }
}
