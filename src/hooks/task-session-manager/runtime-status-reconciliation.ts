import type { PluginInput } from '@opencode-ai/plugin';
import type { BackgroundJobStore, ContextFile } from '../../utils';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../../utils';
import { log } from '../../utils/logger';
import {
  observeNonBusyRuntime,
  STOP_CONFIRMATION_GRACE_MS,
} from './stop-confirmation';

export const RUNTIME_STATUS_RECONCILE_DELAY_MS = 5_000;

export function createRuntimeStatusReconciler(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  delayMs?: number;
  statusTimeoutMs?: number;
  stopConfirmationGraceMs?: number;
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
    const graceMs =
      options.stopConfirmationGraceMs ?? STOP_CONFIRMATION_GRACE_MS;
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
      if (status === 'busy' || status === 'retry') {
        options.backgroundJobBoard.markRunningFromLiveSession(
          job.taskID,
          observedAt,
          job.generation,
        );
        continue;
      }
      if (
        status === undefined &&
        snapshot.malformedSessionIDs.has(job.taskID)
      ) {
        options.backgroundJobBoard.markStatusUncertain(
          job.taskID,
          'Runtime status response did not contain a recognized session state.',
          job.generation,
        );
        continue;
      }

      const lastStatusError =
        status === undefined
          ? 'Runtime status response did not contain a live session state; task termination is unconfirmed.'
          : 'Runtime session is idle; task termination is unconfirmed.';
      const updated = observeNonBusyRuntime({
        backgroundJobBoard: options.backgroundJobBoard,
        taskID: job.taskID,
        observedAt: requestStartedAt,
        generation: job.generation,
        graceMs,
        lastStatusError,
        taskContextTracker: options.taskContextTracker,
      });
      if (updated?.state === 'stopped') {
        log('[task-session-manager] confirmed runtime-stopped job', {
          taskID: updated.taskID,
          alias: updated.alias,
          parentSessionID: updated.parentSessionID,
        });
        continue;
      }
      log(
        '[task-session-manager] runtime session quiescent; terminal result pending',
        {
          taskID: job.taskID,
          generation: job.generation,
        },
      );
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
