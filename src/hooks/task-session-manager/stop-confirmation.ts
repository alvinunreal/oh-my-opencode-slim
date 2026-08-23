import type {
  BackgroundJobRecord,
  BackgroundJobStore,
  ContextFile,
} from '../../utils';

/**
 * Fallback default for the stop-confirmation window when the plugin config
 * does not supply `backgroundJobs.stopConfirmationMs`. The config default is
 * 30s; absence of a session in the runtime status map is never stop evidence.
 */
export const DEFAULT_STOP_CONFIRMATION_MS = 30_000;

export const STOPPED_WITHOUT_TERMINAL_RESULT =
  'Background session stopped before a terminal task result was received.';

export type StopConfirmationTracker = {
  pendingManagedTaskIds: Set<string>;
  contextFilesForPrompt(taskId: string): ContextFile[];
  prune(board: { taskIDs(): Set<string> }): void;
};

export function applyConfirmedStop(options: {
  backgroundJobBoard: BackgroundJobStore;
  taskID: string;
  observedAt: number;
  generation: number;
  taskContextTracker: StopConfirmationTracker;
}): BackgroundJobRecord | undefined {
  const stopped = options.backgroundJobBoard.markStopped(
    options.taskID,
    STOPPED_WITHOUT_TERMINAL_RESULT,
    options.observedAt,
    options.generation,
  );
  if (stopped?.state !== 'stopped') return stopped;
  options.taskContextTracker.pendingManagedTaskIds.delete(options.taskID);
  options.backgroundJobBoard.addContext(
    options.taskID,
    options.taskContextTracker.contextFilesForPrompt(options.taskID),
  );
  options.taskContextTracker.prune(options.backgroundJobBoard);
  return stopped;
}

/**
 * Host-declared idle is the only stop candidate fed here. The first
 * observation starts a grace clock; a later observation after the grace
 * confirms the stop. Live busy after the observation wins and leaves the job
 * running. Absence is never passed to this function: callers route a session
 * missing from the runtime status map to uncertainty-only, because absence
 * does not prove termination.
 */
export function observeNonBusyRuntime(options: {
  backgroundJobBoard: BackgroundJobStore;
  taskID: string;
  observedAt: number;
  generation: number;
  graceMs: number;
  lastStatusError: string;
  taskContextTracker: StopConfirmationTracker;
}): BackgroundJobRecord | undefined {
  const job = options.backgroundJobBoard.get(options.taskID);
  if (job?.state !== 'running' || job.generation !== options.generation) {
    return job;
  }
  if (
    job.lastLiveBusyAt !== undefined &&
    job.lastLiveBusyAt > options.observedAt
  ) {
    return job;
  }

  const observationTime = options.observedAt + 1;
  const startedAt = job.stopConfirmationStartedAt;
  if (
    startedAt === undefined ||
    observationTime - startedAt < options.graceMs
  ) {
    if (startedAt === undefined) {
      options.backgroundJobBoard.noteStopConfirmation(
        options.taskID,
        observationTime,
        options.generation,
      );
    }
    return options.backgroundJobBoard.markStatusUncertain(
      options.taskID,
      options.lastStatusError,
      options.generation,
      options.observedAt,
    );
  }

  return applyConfirmedStop({
    backgroundJobBoard: options.backgroundJobBoard,
    taskID: options.taskID,
    observedAt: observationTime,
    generation: options.generation,
    taskContextTracker: options.taskContextTracker,
  });
}
