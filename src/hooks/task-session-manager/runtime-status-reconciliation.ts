import type { PluginInput } from '@opencode-ai/plugin';
import type { BackgroundJobStore, ContextFile } from '../../utils';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../../utils';
import { log } from '../../utils/logger';

export const RUNTIME_STATUS_RECONCILE_DELAY_MS = 5_000;
const RUNTIME_IDLE_CONFIRMATIONS = 4;

export function createRuntimeStatusReconciler(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  delayMs?: number;
  statusTimeoutMs?: number;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
}) {
  const delayMs = options.delayMs ?? RUNTIME_STATUS_RECONCILE_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let activeReconcile: Promise<void> | undefined;
  let rerunRequested = false;
  const idleConfirmations = new Map<string, number>();

  function schedule(): void {
    if (disposed) return;
    if (activeReconcile) {
      rerunRequested = true;
      return;
    }
    if (timer) return;
    if (
      !options.backgroundJobBoard.list().some((job) => job.state === 'running')
    ) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile();
    }, delayMs);
    timer.unref?.();
  }

  async function reconcilePass(): Promise<void> {
    if (disposed) return;
    const running = options.backgroundJobBoard
      .list()
      .filter((job) => job.state === 'running');
    if (running.length === 0) return;

    const requestStartedAt = Date.now();
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.statusTimeoutMs,
    });
    if (disposed) return;
    const observedAt = Date.now();
    if (snapshot.error) {
      for (const job of running) {
        options.backgroundJobBoard.markStatusUncertain(
          job.taskID,
          `Runtime status lookup failed: ${snapshot.error}`,
          job.generation,
        );
      }
      log('[task-session-manager] runtime status reconciliation uncertain', {
        activeJobs: running.length,
        error: snapshot.error,
      });
      return;
    }

    for (const job of running) {
      if (disposed) return;
      const current = options.backgroundJobBoard.get(job.taskID);
      if (
        current?.state !== 'running' ||
        current.generation !== job.generation
      ) {
        continue;
      }
      const status = runtimeSessionStatus(snapshot, job.taskID);
      if (status === undefined) {
        options.backgroundJobBoard.markStatusUncertain(
          job.taskID,
          'Runtime status response did not contain a recognized session state.',
          job.generation,
        );
        continue;
      }
      if (status === 'busy' || status === 'retry') {
        idleConfirmations.delete(job.taskID);
        options.backgroundJobBoard.markRunningFromLiveSession(
          job.taskID,
          observedAt,
          job.generation,
        );
        continue;
      }

      if (status === 'idle') {
        const confirmations = (idleConfirmations.get(job.taskID) ?? 0) + 1;
        idleConfirmations.set(job.taskID, confirmations);
        if (confirmations < RUNTIME_IDLE_CONFIRMATIONS) {
          options.backgroundJobBoard.markStatusUncertain(
            job.taskID,
            'Runtime session is idle; waiting for a terminal task result.',
            job.generation,
          );
          continue;
        }
      }

      const stopped = options.backgroundJobBoard.markStopped(
        job.taskID,
        'Background session stopped before a terminal task result was received.',
        requestStartedAt,
        job.generation,
      );
      if (stopped?.state !== 'stopped') continue;
      idleConfirmations.delete(job.taskID);
      options.taskContextTracker.pendingManagedTaskIds.delete(job.taskID);
      options.backgroundJobBoard.addContext(
        job.taskID,
        options.taskContextTracker.contextFilesForPrompt(job.taskID),
      );
      options.taskContextTracker.prune(options.backgroundJobBoard);
      log('[task-session-manager] reconciled runtime-stopped job', {
        taskID: stopped.taskID,
        alias: stopped.alias,
        parentSessionID: stopped.parentSessionID,
      });
    }
  }

  async function reconcile(): Promise<void> {
    if (disposed) return;
    if (activeReconcile) {
      rerunRequested = true;
      await activeReconcile;
      return;
    }

    const run = (async () => {
      try {
        do {
          rerunRequested = false;
          await reconcilePass();
        } while (!disposed && rerunRequested);
      } finally {
        activeReconcile = undefined;
        schedule();
      }
    })();
    activeReconcile = run;
    await run;
  }

  function dispose(): void {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return { schedule, reconcile, dispose };
}
