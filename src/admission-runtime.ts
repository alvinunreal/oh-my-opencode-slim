import {
  createPendingCallTracker,
  type PendingCallTracker,
} from './hooks/task-session-manager/pending-call-tracker';
import {
  BackgroundTaskConcurrency,
  type BackgroundTaskConcurrencyConfig,
} from './utils/background-task-concurrency';

export interface AdmissionRuntime {
  readonly backgroundTaskConcurrency: BackgroundTaskConcurrency;
  readonly pendingCallTracker: PendingCallTracker;
}

export interface AdmissionRuntimeLease extends AdmissionRuntime {
  release(): void;
}

interface RuntimeEntry {
  runtime: AdmissionRuntime;
  owners: number;
  teardownTimer?: ReturnType<typeof setTimeout>;
}

const runtimesByDirectory = new Map<string, RuntimeEntry>();
const compatibilityLeases = new Map<string, AdmissionRuntimeLease>();

function directoryKey(directory: string): string {
  return directory || 'default';
}

function disposeEntry(key: string, entry: RuntimeEntry): void {
  if (runtimesByDirectory.get(key) !== entry || entry.owners !== 0) {
    return;
  }
  entry.runtime.pendingCallTracker.clearAll();
  entry.runtime.backgroundTaskConcurrency.dispose();
  runtimesByDirectory.delete(key);
}

/**
 * Acquire the per-directory admission runtime.
 *
 * Plugin generations share this runtime while they overlap. Releasing the
 * last generation is intentionally delayed by one macrotask: OpenCode
 * disposes and recreates a plugin during config updates, and the new factory
 * must be able to reclaim the scheduler and pending calls before teardown.
 */
export function acquireAdmissionRuntime(
  directory: string,
  config: BackgroundTaskConcurrencyConfig,
): AdmissionRuntimeLease {
  const key = directoryKey(directory);
  let entry = runtimesByDirectory.get(key);

  if (entry?.runtime.backgroundTaskConcurrency.isDisposed()) {
    if (entry.teardownTimer !== undefined) {
      clearTimeout(entry.teardownTimer);
    }
    entry.runtime.pendingCallTracker.clearAll();
    runtimesByDirectory.delete(key);
    entry = undefined;
  }

  if (!entry) {
    entry = {
      runtime: {
        backgroundTaskConcurrency: new BackgroundTaskConcurrency(config),
        pendingCallTracker: createPendingCallTracker(),
      },
      owners: 0,
    };
    runtimesByDirectory.set(key, entry);
  } else {
    entry.runtime.backgroundTaskConcurrency.updateConfig(config);
  }

  if (entry.teardownTimer !== undefined) {
    clearTimeout(entry.teardownTimer);
    entry.teardownTimer = undefined;
  }
  entry.owners += 1;
  const ownedEntry = entry;

  let released = false;
  return {
    ...ownedEntry.runtime,
    release: () => {
      if (released) return;
      released = true;
      if (ownedEntry.owners > 0) ownedEntry.owners -= 1;
      if (ownedEntry.owners !== 0 || ownedEntry.teardownTimer !== undefined) {
        return;
      }
      ownedEntry.teardownTimer = setTimeout(() => {
        ownedEntry.teardownTimer = undefined;
        disposeEntry(key, ownedEntry);
      }, 0);
    },
  };
}

/** Test seam: synchronously dispose every directory runtime. */
export function resetAdmissionRuntimeForTests(): void {
  compatibilityLeases.clear();
  for (const [key, entry] of runtimesByDirectory) {
    if (entry.teardownTimer !== undefined) {
      clearTimeout(entry.teardownTimer);
    }
    entry.owners = 0;
    disposeEntry(key, entry);
  }
  runtimesByDirectory.clear();
}

/**
 * Legacy test helper. Production code must acquire and release a lease so a
 * plugin generation cannot keep a directory runtime alive accidentally.
 */
export function getBackgroundTaskConcurrency(
  directory: string,
  config: BackgroundTaskConcurrencyConfig,
): BackgroundTaskConcurrency {
  const key = directoryKey(directory);
  const existing = compatibilityLeases.get(key);
  if (existing && !existing.backgroundTaskConcurrency.isDisposed()) {
    existing.backgroundTaskConcurrency.updateConfig(config);
    return existing.backgroundTaskConcurrency;
  }
  existing?.release();
  const lease = acquireAdmissionRuntime(directory, config);
  compatibilityLeases.set(key, lease);
  return lease.backgroundTaskConcurrency;
}

/** Legacy test helper paired with getBackgroundTaskConcurrency. */
export function resetBackgroundTaskConcurrencyForTests(): void {
  resetAdmissionRuntimeForTests();
}
