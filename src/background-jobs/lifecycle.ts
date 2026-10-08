import type { PluginInput } from '@opencode-ai/plugin';
import { log } from '../utils/logger';
import type { BackgroundJobBoard, BackgroundJobBoardApi } from './board';
import { BackgroundJobBoard as BoardClass } from './board';
import {
  type BackgroundJobLifecycleLedger,
  clearSuppression as clearLedgerSuppression,
  recordSuppression as recordLedgerSuppression,
} from './ledger';
import {
  getSuppressionTombstone,
  type PersistedTombstoneEntry,
} from './persistence';
import {
  type BackgroundJobSupervisor,
  type BackgroundJobSupervisorOptions,
  DefaultBackgroundJobSupervisor,
} from './supervisor';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  type GateResult,
  type ObservationToken,
  type RunRef,
  type RuntimeObservation,
  type TerminalCommitToken,
  type TerminalSignal,
} from './terminal-gate';
import type {
  BackgroundJobAdoptionInput,
  BackgroundJobBoardOptions,
  BackgroundJobEvictedSession,
  BackgroundJobLaunchInput,
  BackgroundJobLease,
  BackgroundJobPromptMetadata,
  BackgroundJobRecord,
  BackgroundJobStatusInput,
  BackgroundJobTerminalInput,
  ContextFile,
  RestoreRetainedSessionInput,
  ReusableSessionSelection,
  WallClockTimeoutClaimInput,
} from './types';

type TerminalStateListener = (taskID: string) => void;
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

export interface BackgroundJobLifecycleOptions {
  // ── Board options (used when no board instance is supplied) ───────
  maxReusablePerAgent?: number;
  maxContextLines?: number;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
  delegationTool?: string;
  deferNumberedAliases?: boolean;
  onEvictedSession?: (evicted: BackgroundJobEvictedSession) => void;
  /** Existing board (tests / advanced wiring). Default: constructed from
   * the board options above. */
  backgroundJobBoard?: BackgroundJobBoard;

  // ── Terminal gate options ─────────────────────────────────────────
  input?: PluginInput;
  graceMs?: number;
  hostOutcomeClock?: 'shared-unix-ms';
  baselineFor?: (taskID: string, generation: number) => string | undefined;
  promptMessageIDFor?: (
    taskID: string,
    generation: number,
  ) => string | undefined;
  attemptStartedAtFor?: (
    taskID: string,
    generation: number,
  ) => number | undefined;
  observationRevisionFor?: (
    taskID: string,
    generation: number,
  ) => number | undefined;
  isObservationPending?: (taskID: string, generation: number) => boolean;
  onRunning?: (record: BackgroundJobRecord) => void;
  onTerminal?: (record: BackgroundJobRecord) => void;
  readRuntime?: (run: RunRef, startedAt: number) => Promise<RuntimeObservation>;
  readTerminalEvidence?: (taskID: string) => Promise<unknown>;
  readTimeoutMs?: number;
  maxEvidenceRetries?: number;
  /** Clock for the gate's internal timings. */
  now?: () => number;
  /** Existing gate (tests). Default: constructed from the gate options
   * above and bound to the lifecycle. */
  gate?: BackgroundJobTerminalGate;

  // ── Supervisor options ────────────────────────────────────────────
  wallClockTimeoutMs?: number;
  abortGraceMs?: number;
  abort?: (taskID: string) => Promise<unknown>;
  setTimeout?: BackgroundJobSupervisorOptions['setTimeout'];
  clearTimeout?: BackgroundJobSupervisorOptions['clearTimeout'];
  /** Existing supervisor (tests). Default: constructed from the supervisor
   * options above (inert when no wallClockTimeoutMs is configured). */
  supervisor?: BackgroundJobSupervisor;
}

/**
 * BackgroundJobLifecycle is the single seam over the background-jobs module.
 * It wraps one board (the state machine), the terminal gate, and the wall
 * clock supervisor, and owns the lifecycle policy:
 * - Subscription interface for terminal state/outcome notifications
 * - Deferred-close policy for managed sessions
 * - Sole-writer delegation to the board
 * - Identity events on register/restore/adopt/clear/drop
 *
 * The board's guards prevent silent overwrites. The lifecycle adds:
 * - Centralized notification with guaranteed delivery
 * - Re-checks board state before notifying (handles races)
 */
export class BackgroundJobLifecycle implements BackgroundJobBoardApi {
  private terminalStateListeners: TerminalStateListener[] = [];
  private terminalOutcomeListeners: TerminalOutcomeListener[] = [];
  private launchIdentityListeners: LaunchIdentityListener[] = [];
  // Stores session IDs (which equal task IDs) awaiting close after background job completes
  private readonly deferredIdleCloses = new Set<string>();
  private gate?: BackgroundJobTerminalGate;
  private supervisor?: BackgroundJobSupervisor;

  constructor(private readonly board: BackgroundJobBoard) {
    // Subscribe to the board's terminal state notifications
    this.board.addTerminalStateListener((taskID) => {
      this.handleTerminalState(taskID);
    });
  }

  /** Wire the privately-held terminal gate (factory step 2). Binding the
   * gate through the lifecycle forwards to board.bindTerminalGate. */
  attachGate(gate: BackgroundJobTerminalGate): void {
    this.gate = gate;
    this.board.bindTerminalGate(gate);
  }

  /** Wire the privately-held supervisor (factory step 3). */
  attachSupervisor(supervisor: BackgroundJobSupervisor): void {
    this.supervisor = supervisor;
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
        log('Lifecycle launch identity listener threw', {
          taskID: event.taskID,
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
    const state = this.board.getState(taskID);
    if (state === undefined) return; // Job was already cleaned up

    // Check if this session should now close
    const closeNow = this.retryDeferredClose(taskID);
    if (closeNow) {
      // Notify listeners that session should close
      for (const listener of this.terminalStateListeners) {
        try {
          listener(taskID);
        } catch (error) {
          log('Lifecycle terminal state listener threw', {
            taskID,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const record = this.board.get?.(taskID);
    if (record) {
      // Observation only: every canonical terminal publication that
      // reaches listener dispatch is logged with its record identity.
      log('[job-lifecycle] terminal state dispatch', {
        taskID,
        generation: record.generation,
        state,
        parentSessionID: record.parentSessionID,
        deferredClose: closeNow,
      });
      for (const listener of this.terminalOutcomeListeners) {
        try {
          listener(record);
        } catch (error) {
          log('Lifecycle terminal outcome listener threw', {
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

  // ── Ledger access ─────────────────────────────────────────────────

  /** Process-local lifecycle memory; one ledger per board instance. */
  get ledger(): BackgroundJobLifecycleLedger {
    return this.board.ledger;
  }

  recordSuppression(
    taskID: string,
    terminal?: {
      state: 'completed' | 'error' | 'cancelled';
      resultSummary: string;
    },
  ): void {
    recordLedgerSuppression(this.board.ledger, taskID, terminal);
  }

  clearSuppression(taskID: string): void {
    clearLedgerSuppression(this.board.ledger, taskID);
  }

  /** Read the persisted suppression tombstone (hydrated at load, maintained
   * by record/clear). Terminal-result entries let a post-restart task_revive
   * surface the recorded result instead of re-prompting the child. */
  suppressionTombstone(taskID: string): PersistedTombstoneEntry | undefined {
    return getSuppressionTombstone(taskID);
  }

  // ── Board extras (outside the old store interface) ────────────────

  /** False for a production parent not created while this board runs. */
  isNumberedAliasReady(parentSessionID: string): boolean {
    return this.board.isNumberedAliasReady(parentSessionID);
  }

  noteSessionCreated(sessionID: string, createdAt: number): void {
    this.board.noteSessionCreated(sessionID, createdAt);
  }

  /** True while the board holds a record or a live lease for the task. */
  isTracked(taskID: string): boolean {
    return this.board.isTracked(taskID);
  }

  /** Subscribe to ANY board mutation (set/delete/trim/drop). The listener
   * receives no payload: re-derive from the lifecycle's read-only queries.
   * Fires after the mutation. */
  addMutationListener(listener: () => void): void {
    this.board.addMutationListener(listener);
  }

  removeMutationListener(listener: () => void): void {
    this.board.removeMutationListener(listener);
  }

  /** Accessible terminal and stopped sessions, grouped for TUI navigation. */
  sidebarHistoryByParentAgent() {
    return this.board.sidebarHistoryByParentAgent();
  }

  // ── Terminal gate seam ────────────────────────────────────────────

  capture(run: RunRef): ObservationToken | undefined {
    return this.gate?.capture(run);
  }

  observe(token: ObservationToken, runtime: RuntimeObservation): GateResult {
    if (!this.gate) throw new Error('Terminal gate is not attached');
    return this.gate.observe(token, runtime);
  }

  reconcile(run: RunRef, signal?: TerminalSignal): Promise<GateResult> {
    if (!this.gate) return Promise.resolve({ kind: 'stale' });
    return this.gate.reconcile(run, signal);
  }

  // ── Supervisor seam ───────────────────────────────────────────────

  /** Register the first observation of a launch or an explicit new run.
   * Delegations tolerate partial supervisors (test seams). */
  onLaunch(record: BackgroundJobRecord): void {
    this.supervisor?.onLaunch?.(record);
  }

  /** Clear one-shot timers after any canonical terminal publication. */
  onTerminal(record: BackgroundJobRecord): void {
    this.supervisor?.onTerminal?.(record);
  }

  /** Deletion fencing before the normal board drop callback. */
  onSessionDeleted(taskID: string): boolean {
    return this.supervisor?.onSessionDeleted?.(taskID) ?? false;
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

  noteStopConfirmation(
    taskID: string,
    startedAt: number,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    return this.board.noteStopConfirmation(
      taskID,
      startedAt,
      expectedGeneration,
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

  getLastLiveBusyAt(taskID: string): number | undefined {
    return this.board.getLastLiveBusyAt(taskID);
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

  hasConvergenceSignals(taskID: string, threshold = 3): boolean {
    return this.board.hasConvergenceSignals(taskID, threshold);
  }

  formatForPrompt(
    parentSessionID: string,
    now = Date.now(),
  ): string | undefined {
    return this.board.formatForPrompt(parentSessionID, now);
  }

  formatForPromptWithMetadata(
    parentSessionID: string,
    now = Date.now(),
  ): BackgroundJobPromptMetadata | undefined {
    return this.board.formatForPromptWithMetadata(parentSessionID, now);
  }

  clearParent(parentSessionID: string): void {
    // The supervisor's timer map is keyed by task and holds no board reads:
    // clear it first, exactly like the deletion choreography this facade
    // replaces, then drop the board records.
    this.supervisor?.clearParent?.(parentSessionID);
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
    // Timer cleanup only: the supervisor never touches board state.
    this.supervisor?.drop?.(taskID);
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

  /** Idempotent local teardown: the terminal gate's timers/authorizations
   * and the supervisor's run timers. Never aborts or writes terminal state. */
  dispose(): void {
    this.gate?.dispose();
    this.supervisor?.dispose?.();
  }
}

/**
 * Compose one BackgroundJobLifecycle from options: board → lifecycle →
 * gate (bound through the lifecycle) → supervisor, replicating the plugin
 * entry's historical wiring order.
 */
export function createBackgroundJobLifecycle(
  options: BackgroundJobLifecycleOptions = {},
): BackgroundJobLifecycle {
  const board =
    options.backgroundJobBoard ??
    new BoardClass({
      maxReusablePerAgent: options.maxReusablePerAgent,
      maxContextLines: options.maxContextLines,
      readContextMinLines: options.readContextMinLines,
      readContextMaxFiles: options.readContextMaxFiles,
      delegationTool: options.delegationTool,
      deferNumberedAliases: options.deferNumberedAliases,
      onEvictedSession: options.onEvictedSession,
    } satisfies BackgroundJobBoardOptions);
  const lifecycle = new BackgroundJobLifecycle(board);
  const gate =
    options.gate ??
    createBackgroundJobTerminalGate({
      backgroundJobBoard: lifecycle,
      input: options.input,
      readRuntime: options.readRuntime,
      readTerminalEvidence: options.readTerminalEvidence,
      baselineFor: options.baselineFor,
      promptMessageIDFor: options.promptMessageIDFor,
      attemptStartedAtFor: options.attemptStartedAtFor,
      observationRevisionFor: options.observationRevisionFor,
      isObservationPending: options.isObservationPending,
      onRunning: options.onRunning,
      onTerminal: options.onTerminal,
      hostOutcomeClock: options.hostOutcomeClock,
      graceMs: options.graceMs,
      readTimeoutMs: options.readTimeoutMs,
      maxEvidenceRetries: options.maxEvidenceRetries,
      now: options.now,
    });
  lifecycle.attachGate(gate);
  const supervisor =
    options.supervisor ??
    new DefaultBackgroundJobSupervisor({
      backgroundJobStore: lifecycle,
      terminalGate: gate,
      wallClockTimeoutMs: options.wallClockTimeoutMs ?? 0,
      abortGraceMs: options.abortGraceMs ?? 0,
      abort:
        options.abort ??
        (async () => {
          // No abort wired: supervision stays inert (wallClockTimeoutMs 0).
        }),
      now: options.now,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
    });
  lifecycle.attachSupervisor(supervisor);
  return lifecycle;
}
