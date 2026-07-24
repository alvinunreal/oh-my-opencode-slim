import type {
  BackgroundJobLaunchInput,
  BackgroundJobRecord,
  BackgroundJobStatusInput,
  ContextFile,
  WallClockTimeoutClaimInput,
  WallClockTimeoutFinalizeInput,
} from './background-job-board';
import type { TaskOutputState } from './task';

/**
 * Unified interface for background job operations.
 * Both BackgroundJobBoard and BackgroundJobCoordinator satisfy this.
 *
 * ponytail: single interface, both board and coordinator implement it.
 */
export interface BackgroundJobStore {
  // ── Mutation methods ──────────────────────────────────────────────
  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord;
  updateStatus(
    input: BackgroundJobStatusInput,
  ): BackgroundJobRecord | undefined;
  updateFromStatusOutput(output: string): BackgroundJobRecord | undefined;
  claimWallClockDeadline(
    input: WallClockTimeoutClaimInput,
  ): BackgroundJobRecord | undefined;
  finalizeWallClockTimeout(
    input: WallClockTimeoutFinalizeInput,
  ): BackgroundJobRecord | undefined;
  markRunningFromLiveSession(
    taskID: string,
    now?: number,
  ): BackgroundJobRecord | undefined;
  markReconciled(taskID: string, now?: number): BackgroundJobRecord | undefined;
  markCancelled(
    taskID: string,
    reason?: string,
    now?: number,
    options?: { force?: boolean },
  ): BackgroundJobRecord | undefined;
  clearParent(parentSessionID: string): void;
  drop(taskID: string): void;
  addContext(taskID: string, files: ContextFile[]): void;
  markUsed(parentSessionID: string, key: string, now?: number): void;

  // ── Query methods ─────────────────────────────────────────────────
  get(taskID: string): BackgroundJobRecord | undefined;
  field<K extends keyof BackgroundJobRecord>(
    taskID: string,
    key: K,
  ): BackgroundJobRecord[K] | undefined;
  isRunning(taskID: string): boolean;
  isTerminalUnreconciled(taskID: string): boolean;
  getResultSummary(taskID: string): string | undefined;
  getLastLiveBusyAt(taskID: string): number | undefined;
  getParentSessionID(taskID: string): string | undefined;
  getState(taskID: string): TaskOutputState | 'reconciled' | undefined;
  resolve(
    parentSessionID: string,
    taskIDOrAlias: string,
  ): BackgroundJobRecord | undefined;
  resolveReusable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined;
  resolveRecoverable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined;
  taskIDs(): Set<string>;
  list(parentSessionID?: string): BackgroundJobRecord[];
  hasRunning(parentSessionID: string): boolean;
  hasTerminalUnreconciled(parentSessionID: string): boolean;
  hasConvergenceSignals(taskID: string, threshold?: number): boolean;
  formatForPrompt(parentSessionID: string, now?: number): string | undefined;

  // ── Lifecycle policy ─────────────────────────────────────────────
  /** Evaluate close policy. Returns true if session should close now.
   *  Mutates deferred state: adds to deferred set if running, removes if not. */
  deferIfRunning(sessionId: string): boolean;
  /** Retry closing a deferred session. Returns true if session should now close. */
  retryDeferredClose(sessionId: string): boolean;
  /** Clear deferred close state for a session being deleted. */
  clearDeferredClose(sessionId: string): void;
}
