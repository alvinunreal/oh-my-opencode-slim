import type {
  BackgroundJobAdoptionInput,
  BackgroundJobBoard,
  BackgroundJobLaunchInput,
  BackgroundJobLease,
  BackgroundJobRecord,
  BackgroundJobStatusInput,
  BackgroundJobTerminalInput,
  ContextFile,
  RestoreRetainedSessionInput,
  WallClockTimeoutClaimInput,
} from './background-job-board';
import type { BackgroundJobStore } from './background-job-store';
import type {
  BackgroundJobTerminalGate,
  TerminalCommitToken,
} from './background-job-terminal-gate';
import { log } from './logger';

type TerminalOutcomeListener = (record: BackgroundJobRecord) => void;

/**
 * Identity projection event for accepted/removed launches. Consumed by the
 * host plugin to mirror alias↔session links into TUI state; consumers must
 * be best-effort (failures are logged, never propagated to the launch).
 */
export interface BackgroundJobIdentityEvent {
  kind: 'registered' | 'removed';
  taskID: string;
  parentSessionID: string;
  agent: string;
  alias: string;
}

type LaunchIdentityListener = (event: BackgroundJobIdentityEvent) => void;

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
  private terminalOutcomeListeners: TerminalOutcomeListener[] = [];
  private launchIdentityListeners: LaunchIdentityListener[] = [];

  constructor(private readonly board: BackgroundJobBoard) {
    // Terminal publication seam: the coordinator is the sole board→outcome
    // subscriber, so it owns this single internal notification rather than a
    // listener list the board would only ever fill with one entry.
    this.board.setTerminalPublicationHandler((taskID) => {
      this.handleTerminalState(taskID);
    });
  }

  // ── Launch identity projection (best-effort, sidebar details) ─────

  addLaunchIdentityListener(listener: LaunchIdentityListener): void {
    this.launchIdentityListeners.push(listener);
  }

  private notifyLaunchIdentity(event: BackgroundJobIdentityEvent): void {
    for (const listener of this.launchIdentityListeners) {
      try {
        listener(event);
      } catch (error) {
        log('Coordinator launch identity listener threw', {
          taskID: event.taskID,
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle terminal state from board. Re-checks board state to handle races.
   * This is the centralized lifecycle policy.
   */
  private handleTerminalState(taskID: string): void {
    // Re-check board state to handle races
    const state = this.board.getState(taskID);
    if (state === undefined) return; // Job was already cleaned up

    const record = this.board.get?.(taskID);
    if (record) {
      // Observation only: every canonical terminal publication that
      // reaches listener dispatch is logged with its record identity.
      log('[job-coordinator] terminal state dispatch', {
        taskID,
        generation: record.generation,
        state,
        parentSessionID: record.parentSessionID,
      });
      for (const listener of this.terminalOutcomeListeners) {
        try {
          listener(record);
        } catch (error) {
          log('Coordinator terminal outcome listener threw', {
            taskID,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /** Observe every canonical terminal publication, including non-idle jobs. */
  addTerminalOutcomeListener(listener: TerminalOutcomeListener): void {
    this.terminalOutcomeListeners.push(listener);
  }

  removeTerminalOutcomeListener(listener: TerminalOutcomeListener): void {
    this.terminalOutcomeListeners = this.terminalOutcomeListeners.filter(
      (entry) => entry !== listener,
    );
  }

  // ── Mutation methods (sole writer to board) ──────────────────────

  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord {
    const record = this.board.registerLaunch(input);
    this.notifyLaunchIdentity({
      kind: 'registered',
      taskID: record.taskID,
      parentSessionID: record.parentSessionID,
      agent: record.agent,
      alias: record.alias,
    });
    return record;
  }

  abandonLaunch(
    launched: BackgroundJobRecord,
    replaced: BackgroundJobRecord,
  ): boolean {
    return this.board.abandonLaunch(launched, replaced);
  }

  correctStartupRecoveredTerminal(input: {
    taskID: string;
    generation: number;
    state: 'completed' | 'error' | 'cancelled' | 'stopped';
    resultSummary?: string;
    now?: number;
  }): BackgroundJobRecord | undefined {
    return this.board.correctStartupRecoveredTerminal(input);
  }

  restoreRetainedSession(
    input: RestoreRetainedSessionInput,
  ): BackgroundJobRecord | undefined {
    const record = this.board.restoreRetainedSession(input);
    if (!record) return undefined;
    this.notifyLaunchIdentity({
      kind: 'registered',
      taskID: record.taskID,
      parentSessionID: record.parentSessionID,
      agent: record.agent,
      alias: record.alias,
    });
    return record;
  }

  adoptTerminal(
    input: BackgroundJobAdoptionInput,
  ): BackgroundJobRecord | undefined {
    const record = this.board.adoptTerminal(input);
    if (!record) return;
    const { taskID, parentSessionID, agent, alias } = record;
    this.notifyLaunchIdentity({
      kind: 'registered',
      taskID,
      parentSessionID,
      agent,
      alias,
    });
    return record;
  }

  acquireCancellationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    return this.board.acquireCancellationLease(taskID, generation);
  }

  acquireRelaunchLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    return this.board.acquireRelaunchLease(taskID, generation);
  }

  acquireMessageLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    return this.board.acquireMessageLease(taskID, generation);
  }

  acquireTerminalNotificationLease(
    taskID: string,
    generation: number,
    terminalRevision?: number,
  ): BackgroundJobLease | undefined {
    return this.board.acquireTerminalNotificationLease(
      taskID,
      generation,
      terminalRevision,
    );
  }

  validateLease(lease: BackgroundJobLease): boolean {
    return this.board.validateLease(lease);
  }

  releaseLease(lease: BackgroundJobLease): boolean {
    return this.board.releaseLease(lease);
  }

  updateStatus(
    input: BackgroundJobStatusInput & { state: 'running' },
  ): BackgroundJobRecord | undefined {
    return this.board.updateStatus(input);
  }

  commitTerminal(
    input: BackgroundJobTerminalInput,
    token: TerminalCommitToken,
  ): BackgroundJobRecord | undefined {
    return this.board.commitTerminal(input, token);
  }

  bindTerminalGate(gate: BackgroundJobTerminalGate): void {
    this.board.bindTerminalGate(gate);
  }

  claimWallClockDeadline(
    input: WallClockTimeoutClaimInput,
  ): BackgroundJobRecord | undefined {
    return this.board.claimWallClockDeadline(input);
  }

  markRunningFromLiveSession(
    taskID: string,
    now = Date.now(),
    expectedGeneration?: number,
    observedTerminalRevision?: number,
  ): BackgroundJobRecord | undefined {
    return this.board.markRunningFromLiveSession(
      taskID,
      now,
      expectedGeneration,
      observedTerminalRevision,
    );
  }

  markStatusUncertain(
    taskID: string,
    lastStatusError: string,
    expectedGeneration?: number,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    return this.board.markStatusUncertain(
      taskID,
      lastStatusError,
      expectedGeneration,
      now,
    );
  }

  markReconciled(
    taskID: string,
    now = Date.now(),
    expectedGeneration?: number,
    expectedRevision?: number,
  ): BackgroundJobRecord | undefined {
    return this.board.markReconciled(
      taskID,
      now,
      expectedGeneration,
      expectedRevision,
    );
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

  getParentSessionID(taskID: string): string | undefined {
    return this.board.getParentSessionID(taskID);
  }

  getState(taskID: string): BackgroundJobRecord['state'] | undefined {
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

  hasRunningJobs(): boolean {
    return this.board.hasRunningJobs();
  }

  hasRunning(parentSessionID: string): boolean {
    return this.board.hasRunning(parentSessionID);
  }

  hasTerminalUnreconciled(parentSessionID: string): boolean {
    return this.board.hasTerminalUnreconciled(parentSessionID);
  }

  promoteProvisional(
    taskID: string,
    expectedParentSessionID?: string,
    metadata?: {
      agent?: string;
      description?: string;
      objective?: string;
      background?: boolean;
    },
  ): BackgroundJobRecord | undefined {
    return this.board.promoteProvisional(
      taskID,
      expectedParentSessionID,
      metadata,
    );
  }

  clearParent(parentSessionID: string): void {
    // Capture identities before the board removes them so the projection
    // can retract aliases for every affected record.
    const removed = this.board.list(parentSessionID);
    this.board.clearParent(parentSessionID);
    for (const record of removed) {
      this.notifyLaunchIdentity({
        kind: 'removed',
        taskID: record.taskID,
        parentSessionID: record.parentSessionID,
        agent: record.agent,
        alias: record.alias,
      });
    }
  }

  drop(taskID: string): void {
    const record = this.board.get(taskID);
    this.board.drop(taskID);
    if (record) {
      this.notifyLaunchIdentity({
        kind: 'removed',
        taskID: record.taskID,
        parentSessionID: record.parentSessionID,
        agent: record.agent,
        alias: record.alias,
      });
    }
  }
}
