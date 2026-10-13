import type { PluginInput } from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import {
  type BackgroundJobTerminalGate,
  runtimeObservationFromSnapshot,
} from '../../utils/background-job-terminal-gate';
import { log } from '../../utils/logger';
import { getRuntimeSessionStatusSnapshot } from '../../utils/session-runtime-status';

export const RUNTIME_STATUS_RECONCILE_DELAY_MS = 5_000;

/** Batching, cadence and capability detection only; no terminal policy. */
export function createRuntimeStatusReconciler(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  terminalGate: BackgroundJobTerminalGate;
  delayMs?: number;
  statusTimeoutMs?: number;
}) {
  const delayMs = options.delayMs ?? RUNTIME_STATUS_RECONCILE_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let activeReconcile: Promise<void> | undefined;
  let rerunRequested = false;
  let pendingRetryAfter: Promise<void> | undefined;
  let capability: boolean | undefined;
  function supported(): boolean {
    if (capability === undefined) {
      capability = typeof options.input?.client?.session?.status === 'function';
      if (!capability)
        log(
          '[task-session-manager] runtime status reconciliation disabled on this host (client.session.status unavailable)',
        );
    }
    return capability;
  }
  function schedule(): void {
    if (
      disposed ||
      !supported() ||
      activeReconcile ||
      timer ||
      !options.backgroundJobBoard.hasRunningJobs()
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      // Background reconciliation is fail-soft: a failure must be logged
      // and swallowed, never escape as an unhandled rejection.
      void reconcile().catch((err) => {
        log(
          '[runtime-status-reconciliation] background reconcile failed',
          String(err),
        );
      });
    }, delayMs);
    timer.unref?.();
  }
  async function pass(): Promise<void> {
    if (disposed || !supported()) return;
    // Requested/rehydration passes include retained terminals. Routine
    // scheduling stops when no jobs run, so inactive history is not polled.
    const tokens = options.backgroundJobBoard.list().flatMap((run) => {
      const token = options.terminalGate.capture(run);
      return token ? [token] : [];
    });
    if (!tokens.length) return;
    const startedAt = Date.now();
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.statusTimeoutMs,
    });
    if (disposed) return;
    if (snapshot.retryAfter) {
      // A collision is not an observation: rerun the whole pass once the open
      // read settles, instead of one full-map read per task through the gate.
      if (snapshot.retryAfter === pendingRetryAfter) return;
      pendingRetryAfter = snapshot.retryAfter;
      void snapshot.retryAfter
        .then(() => {
          pendingRetryAfter = undefined;
          return reconcile();
        })
        .catch((err) => {
          log('[runtime-status-reconciliation] rerun failed', String(err));
        });
      return;
    }
    const pending: Promise<unknown>[] = [];
    for (const token of tokens) {
      const result = options.terminalGate.observe(
        token,
        runtimeObservationFromSnapshot(snapshot, token.taskID, startedAt),
      );
      if (result.kind !== 'stale')
        pending.push(options.terminalGate.reconcile(token));
    }
    await Promise.all(pending);
  }
  async function reconcile(): Promise<void> {
    if (disposed) return;
    if (activeReconcile) {
      rerunRequested = true;
      await activeReconcile;
      return;
    }
    activeReconcile = (async () => {
      try {
        do {
          rerunRequested = false;
          await pass();
        } while (!disposed && rerunRequested);
      } finally {
        activeReconcile = undefined;
        schedule();
      }
    })();
    await activeReconcile;
  }
  return {
    schedule,
    reconcile,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
