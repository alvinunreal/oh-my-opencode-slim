import type {
  BackgroundJobBoard,
  BackgroundJobLaunchInput,
  BackgroundJobRecord,
  BackgroundJobStatusInput,
  ContextFile,
} from './background-job-board';
import type { BackgroundJobStore } from './background-job-store';
import type { TaskOutputState } from './task';

type TerminalStateListener = (taskID: string) => void;

/**
 * BackgroundJobCoordinator owns the lifecycle policy for background jobs.
 * It sits between the board and its consumers, providing:
 * - Subscription interface for terminal state notifications (replaces fire-and-forget)
 * - Lifecycle policy: determines when jobs are terminal, when closes should be deferred
 * - Single-writer contract: coordinator is the sole writer to the board
 *
 * The board's guards prevent silent overwrites. The coordinator adds:
 * - Centralized notification with guaranteed delivery
 * - Re-checks board state before notifying (handles races)
 */
export class BackgroundJobCoordinator implements BackgroundJobStore {
  private terminalStateListeners: TerminalStateListener[] = [];
  // Stores session IDs (which equal task IDs) awaiting close after background job completes
  private readonly deferredIdleCloses = new Set<string>();

  constructor(private readonly board: BackgroundJobBoard) {
    // Subscribe to the board's terminal state notifications
    this.board.addTerminalStateListener((taskID) => {
      this.handleTerminalState(taskID);
    });
  }

  // ── Terminal state notification (guaranteed delivery) ─────────────

  addTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners.push(listener);
  }

  removeTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners = this.terminalStateListeners.filter(
      (entry) => entry !== listener,
    );
  }

  /**
   * Handle terminal state from board. Re-checks board state to handle races.
   * This is the centralized lifecycle policy.
   */
  private handleTerminalState(taskID: string): void {
    // Re-check board state to handle races
    if (this.board.getState(taskID) === undefined) return;

    // Notify listeners on any terminal/timeout state
    for (const listener of this.terminalStateListeners) {
      listener(taskID);
    }
  }

  // ── Lifecycle policy ─────────────────────────────────────────────

  /**
   * Evaluate close policy. Returns true if session should close now.
   * Mutates deferred state: adds to deferred set if running, removes if not.
   */
  deferIfRunning(sessionId: string): boolean {
    if (!this.board.isRunning(sessionId)) {
      this.deferredIdleCloses.delete(sessionId);
      return true;
    }
    this.deferredIdleCloses.add(sessionId);
    return false;
  }

  /**
   * Retry closing a deferred session. Called when a background job completes.
   * Returns true if the session should now close.
   */
  retryDeferredClose(sessionId: string): boolean {
    if (!this.deferredIdleCloses.has(sessionId)) return false;
    return this.deferIfRunning(sessionId);
  }

  /**
   * Clear deferred close state for a session being deleted.
   */
  clearDeferredClose(sessionId: string): void {
    this.deferredIdleCloses.delete(sessionId);
  }

  // ── Mutation methods (sole writer to board) ──────────────────────

  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord {
    return this.board.registerLaunch(input);
  }

  updateStatus(
    input: BackgroundJobStatusInput,
  ): BackgroundJobRecord | undefined {
    return this.board.updateStatus(input);
  }

  updateFromStatusOutput(output: string): BackgroundJobRecord | undefined {
    return this.board.updateFromStatusOutput(output);
  }

  markRunningFromLiveSession(
    taskID: string,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    return this.board.markRunningFromLiveSession(taskID, now);
  }

  markReconciled(
    taskID: string,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    return this.board.markReconciled(taskID, now);
  }

  markCancelled(
    taskID: string,
    reason?: string,
    now = Date.now(),
    options: { force?: boolean } = {},
  ): BackgroundJobRecord | undefined {
    return this.board.markCancelled(taskID, reason, now, options);
  }

  // ── Query methods ────────────────────────────────────────────────

  get(taskID: string): BackgroundJobRecord | undefined {
    return this.board.get(taskID);
  }

  field<K extends keyof BackgroundJobRecord>(
    taskID: string,
    key: K,
  ): BackgroundJobRecord[K] | undefined {
    return this.board.field(taskID, key);
  }

  isRunning(taskID: string): boolean {
    return this.board.isRunning(taskID);
  }

  isTerminalUnreconciled(taskID: string): boolean {
    return this.board.isTerminalUnreconciled(taskID);
  }

  getResultSummary(taskID: string): string | undefined {
    return this.board.getResultSummary(taskID);
  }

  getLastLiveBusyAt(taskID: string): number | undefined {
    return this.board.getLastLiveBusyAt(taskID);
  }

  getParentSessionID(taskID: string): string | undefined {
    return this.board.getParentSessionID(taskID);
  }

  getState(taskID: string): TaskOutputState | 'reconciled' | undefined {
    return this.board.getState(taskID);
  }

  resolve(
    parentSessionID: string,
    taskIDOrAlias: string,
  ): BackgroundJobRecord | undefined {
    return this.board.resolve(parentSessionID, taskIDOrAlias);
  }

  resolveReusable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    return this.board.resolveReusable(parentSessionID, taskIDOrAlias, agent);
  }

  resolveRecoverable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    return this.board.resolveRecoverable(parentSessionID, taskIDOrAlias, agent);
  }

  markUsed(parentSessionID: string, key: string, now = Date.now()): void {
    this.board.markUsed(parentSessionID, key, now);
  }

  taskIDs(): Set<string> {
    return this.board.taskIDs();
  }

  addContext(taskID: string, files: ContextFile[]): void {
    this.board.addContext(taskID, files);
  }

  list(parentSessionID?: string): BackgroundJobRecord[] {
    return this.board.list(parentSessionID);
  }

  hasRunning(parentSessionID: string): boolean {
    return this.board.hasRunning(parentSessionID);
  }

  hasTerminalUnreconciled(parentSessionID: string): boolean {
    return this.board.hasTerminalUnreconciled(parentSessionID);
  }

  hasConvergenceSignals(taskID: string, threshold = 3): boolean {
    return this.board.hasConvergenceSignals(taskID, threshold);
  }

  formatForPrompt(
    parentSessionID: string,
    now = Date.now(),
  ): string | undefined {
    return this.board.formatForPrompt(parentSessionID, now);
  }

  clearParent(parentSessionID: string): void {
    this.board.clearParent(parentSessionID);
  }

  drop(taskID: string): void {
    this.board.drop(taskID);
  }
}
