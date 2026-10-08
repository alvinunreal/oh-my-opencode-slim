import {
  DEFAULT_MAX_CONTEXT_LINES,
  DEFAULT_MAX_SESSIONS_PER_AGENT,
  DEFAULT_READ_CONTEXT_MAX_FILES,
  DEFAULT_READ_CONTEXT_MIN_LINES,
  formatSystemReminder,
} from '../config/constants';
import { escapeRegExp } from '../utils/agent-variant';
import { log } from '../utils/logger';
import type { TaskOutputState } from '../utils/task';
import {
  clearSuppression,
  createLifecycleLedger,
  recordSuppression,
} from './ledger';
import {
  type BackgroundJobTerminalGate,
  consumeTerminalCommitToken,
  type TerminalCommitToken,
} from './terminal-gate';
import {
  AGED_ENTRY_RENDER_TTL_MS,
  type BackgroundJobAdoptionInput,
  type BackgroundJobBoardOptions,
  type BackgroundJobEvictedSession,
  BackgroundJobLaunchConflictError,
  type BackgroundJobLaunchInput,
  type BackgroundJobLease,
  type BackgroundJobLeaseKind,
  type BackgroundJobPromptMetadata,
  type BackgroundJobRecord,
  type BackgroundJobState,
  type BackgroundJobStatusInput,
  type BackgroundJobTerminalInput,
  type ContextFile,
  type RestoreRetainedSessionInput,
  type ReusableSessionSelection,
  STATUS_UNCERTAIN_DEMOTE_AFTER_MS,
  type WallClockTimeoutClaimInput,
  type WallClockTimeoutFinalizeInput,
} from './types';

type TerminalStateListener = (taskID: string) => void;
type MutationListener = () => void;

const CANONICAL_TERMINAL_STATES = new Set<TaskOutputState>([
  'completed',
  'error',
  'cancelled',
]);

const AGENT_PREFIX: Record<string, string> = {
  council: 'cou',
  designer: 'des',
  explorer: 'exp',
  fixer: 'fix',
  librarian: 'lib',
  observer: 'obs',
  oracle: 'ora',
};

/** Numbered-alias prefix for an agent. Unknown agents use a 3-letter fallback. */
function aliasPrefixForAgent(agent: string): string {
  return AGENT_PREFIX[agent] ?? (agent.slice(0, 3) || 'job');
}

/**
 * Structural surface of the board's state machine. The lifecycle facade
 * (BackgroundJobLifecycle) extends it; the terminal gate and supervisor
 * consume it structurally, so tests may pass raw boards.
 */
export interface BackgroundJobBoardApi {
  // ── Mutation methods ──────────────────────────────────────────────
  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord;
  /** Restore the record a launch replaced after the host explicitly refused
   * it. False once that launch's generation no longer owns the row. */
  abandonLaunch(
    launched: BackgroundJobRecord,
    replaced: BackgroundJobRecord,
  ): boolean;
  /** Cache-only import of an absent verified host session. */
  restoreRetainedSession(
    input: RestoreRetainedSessionInput,
  ): BackgroundJobRecord | undefined;
  /**
   * Insert an already-terminal (`reconciled`) record for a child session the
   * store does not hold; returns undefined when it does. Unlike
   * `commitTerminal`, no terminal-gate token is consumed, so the caller must
   * supply host evidence itself: an idle child whose transcript classifies as
   * completed/error via `classifyTerminalEvidence`. Fires no terminal-state
   * listener. Not a way to settle runs the terminal gate tracks.
   */
  adoptTerminal(
    input: BackgroundJobAdoptionInput,
  ): BackgroundJobRecord | undefined;
  acquireCancellationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined;
  acquireRelaunchLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined;
  acquireMessageLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined;
  acquireTerminalNotificationLease(
    taskID: string,
    generation: number,
    terminalRevision?: number,
  ): BackgroundJobLease | undefined;
  validateLease(lease: BackgroundJobLease): boolean;
  releaseLease(lease: BackgroundJobLease): boolean;
  updateStatus(
    input: BackgroundJobStatusInput & { state: 'running' },
  ): BackgroundJobRecord | undefined;
  commitTerminal(
    input: BackgroundJobTerminalInput,
    token: TerminalCommitToken,
  ): BackgroundJobRecord | undefined;
  bindTerminalGate(gate: BackgroundJobTerminalGate): void;
  claimWallClockDeadline(
    input: WallClockTimeoutClaimInput,
  ): BackgroundJobRecord | undefined;
  markRunningFromLiveSession(
    taskID: string,
    now?: number,
    expectedGeneration?: number,
    observedTerminalRevision?: number,
  ): BackgroundJobRecord | undefined;
  noteStopConfirmation(
    taskID: string,
    startedAt: number,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined;
  markStatusUncertain(
    taskID: string,
    lastStatusError: string,
    expectedGeneration?: number,
    now?: number,
  ): BackgroundJobRecord | undefined;
  /**
   * Acknowledge the terminal notification delivered to the parent session.
   * This is a prompt-lifecycle acknowledgement, not filesystem reconciliation.
   */
  markReconciled(
    taskID: string,
    now?: number,
    expectedGeneration?: number,
    expectedRevision?: number,
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
  getState(taskID: string): BackgroundJobRecord['state'] | undefined;
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
  /** Cheap global check for any running job: single pass, no copy or sort. */
  hasRunningJobs(): boolean;
  hasRunning(parentSessionID: string): boolean;
  hasTerminalUnreconciled(parentSessionID: string): boolean;
  /** Attributing evidence promotes a placeholder into a tracked task.
   *  Terminal promotions re-emit the suppressed recovery wake. */
  promoteProvisional(
    taskID: string,
    expectedParentSessionID?: string,
    metadata?: {
      agent?: string;
      description?: string;
      objective?: string;
      background?: boolean;
    },
  ): BackgroundJobRecord | undefined;
  hasConvergenceSignals(taskID: string, threshold?: number): boolean;
  formatForPrompt(parentSessionID: string, now?: number): string | undefined;
  formatForPromptWithMetadata(
    parentSessionID: string,
    now?: number,
  ): BackgroundJobPromptMetadata | undefined;

  // ── Lifecycle policy ─────────────────────────────────────────────
  /** Evaluate close policy. Returns true if session should close now.
   *  Mutates deferred state: adds to deferred set if running, removes if not. */
  deferIfRunning(sessionId: string): boolean;
  /** Retry closing a deferred session. Returns true if session should now close. */
  retryDeferredClose(sessionId: string): boolean;
  /** Clear deferred close state for a session being deleted. */
  clearDeferredClose(sessionId: string): void;
}

export class BackgroundJobBoard {
  private terminalGate?: BackgroundJobTerminalGate;
  private readonly jobs = new Map<string, BackgroundJobRecord>();
  /**
   * Process-local lifecycle memory (tombstones, deletion epochs, injected
   * completion fences). One ledger per board instance, seeded from
   * backend-loaded persistence at construction.
   */
  readonly ledger = createLifecycleLedger();
  /** One live operation/relaunch owner per native session ID. */
  private readonly liveLeases = new Map<string, BackgroundJobLease>();
  private readonly counters = new Map<string, number>();
  private executionSequence = 0;
  private leaseSequence = 0;
  private terminalStateListeners: TerminalStateListener[] = [];
  private mutationListeners: MutationListener[] = [];

  private readonly maxReusablePerAgent: number;
  private readonly maxContextLines: number;
  private readonly readContextMinLines: number;
  private readonly readContextMaxFiles: number;
  private readonly delegationTool: string;
  private readonly deferNumberedAliases: boolean;
  private readonly onEvictedSession?:
    | ((evicted: BackgroundJobEvictedSession) => void)
    | undefined;
  private readonly startedAt = Date.now();
  /** Sessions created after this board started: no earlier aliases. */
  private readonly freshParents = new Set<string>();

  constructor(options: BackgroundJobBoardOptions = {}) {
    this.maxReusablePerAgent =
      options.maxReusablePerAgent ?? DEFAULT_MAX_SESSIONS_PER_AGENT;
    this.maxContextLines = options.maxContextLines ?? DEFAULT_MAX_CONTEXT_LINES;
    this.readContextMinLines =
      options.readContextMinLines ?? DEFAULT_READ_CONTEXT_MIN_LINES;
    this.readContextMaxFiles =
      options.readContextMaxFiles ?? DEFAULT_READ_CONTEXT_MAX_FILES;
    this.delegationTool = options.delegationTool ?? 'task';
    this.deferNumberedAliases = options.deferNumberedAliases === true;
    this.onEvictedSession = options.onEvictedSession;
  }

  /** False for a production parent not created while this board runs. */
  isNumberedAliasReady(parentSessionID: string): boolean {
    return !this.deferNumberedAliases || this.freshParents.has(parentSessionID);
  }

  /**
   * A session created after this board started has issued no numbered
   * alias, so its children count from 1. An older or replayed creation
   * keeps task IDs: no cheap host read bounds numbers from before a restart.
   */
  noteSessionCreated(sessionID: string, createdAt: number): void {
    if (createdAt >= this.startedAt) this.freshParents.add(sessionID);
  }

  addTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners.push(listener);
  }

  removeTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners = this.terminalStateListeners.filter(
      (entry) => entry !== listener,
    );
  }

  setTerminalStateListener(listener?: TerminalStateListener): void {
    this.terminalStateListeners = listener ? [listener] : [];
  }

  /** Subscribe to ANY board mutation (set/delete/trim/drop). The listener
   * receives no payload: re-derive from the board's read-only queries.
   * Same style as addTerminalStateListener; fires after the mutation. */
  addMutationListener(listener: MutationListener): void {
    this.mutationListeners.push(listener);
  }

  removeMutationListener(listener: MutationListener): void {
    this.mutationListeners = this.mutationListeners.filter(
      (entry) => entry !== listener,
    );
  }

  private notifyMutationListeners(): void {
    for (const listener of this.mutationListeners) {
      try {
        listener();
      } catch (error) {
        log('Board mutation listener threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private notifyTerminalStateListeners(taskID: string): void {
    for (const listener of this.terminalStateListeners) {
      try {
        listener(taskID);
      } catch (error) {
        log('Board terminal state listener threw', {
          taskID,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord {
    const now = input.now ?? Date.now();
    const existing = this.jobs.get(input.taskID);
    const requestedLease = input.relaunchLease ?? input.lease;
    const liveLease = this.liveLeases.get(input.taskID);

    if (requestedLease) {
      if (
        requestedLease.kind !== 'relaunch' ||
        !this.validateLease(requestedLease) ||
        requestedLease.taskID !== input.taskID ||
        existing?.generation !== requestedLease.generation
      ) {
        throw new BackgroundJobLaunchConflictError(
          input.taskID,
          'the relaunch lease is missing, stale, or belongs to another generation',
        );
      }
    }

    if (liveLease) {
      if (
        liveLease.kind !== 'relaunch' ||
        requestedLease === undefined ||
        !this.validateLease(requestedLease)
      ) {
        throw new BackgroundJobLaunchConflictError(
          input.taskID,
          `a ${liveLease.kind} lease already owns this session`,
        );
      }
    }

    clearSuppression(this.ledger, input.taskID);
    const generation = ++this.executionSequence;

    if (existing) {
      if (input.preserveRun) {
        if (existing.state !== 'running') {
          // Attribution via the owning call promotes a placeholder even when
          // its run already reached a terminal state; state, generation, and
          // terminal evidence stay untouched.
          if (!existing.provisional) return existing;
          const promoted = { ...existing, provisional: false };
          this.setJob(promoted);
          // The stop-time notification skipped this record while it was
          // still provisional; the attributed record owes the wake.
          this.notifyTerminalStateListeners(input.taskID);
          return promoted;
        }
        const observed = {
          ...existing,
          provisional: false,
          agent: input.agent || existing.agent,
          description: input.description || existing.description,
          objective: input.objective ?? existing.objective,
          background: existing.background || input.background === true,
          ...(existing.pluginLaunched ||
          (input.pluginLaunched === true &&
            input.adopted !== true &&
            existing.provisional !== true &&
            existing.externalOrigin !== true &&
            (existing.background || input.background === true))
            ? { pluginLaunched: true as const }
            : {}),
        } satisfies BackgroundJobRecord;
        this.setJob(observed);
        return observed;
      }

      const updated = {
        ...existing,
        provisional: false,
        generation,
        terminalRevision: 0,
        activityRevision: 0,
        taskGeneration: existing.taskGeneration + 1,
        agent: input.agent || existing.agent,
        description: input.description || existing.description,
        objective: input.objective ?? existing.objective,
        state: 'running',
        background: input.background ?? existing.background,
        timedOut: false,
        recoverableAfterLiveBusy: false,
        statusUncertain: false,
        // A relaunch starts a fresh episode: no stale demotion clock.
        statusUncertainSince: undefined,
        cancellationRequested: false,
        terminalUnreconciled: false,
        completedAt: undefined,
        resultSummary: undefined,
        lastStatusError: undefined,
        terminalState: undefined,
        verifiedRetainedRound: undefined,
        recoveredWithoutPrompt: undefined,
        lastLaunchedAt: now,
        runStartedAt: now,
        deadlineExceededAt: undefined,
        lastLiveBusyAt: now,
        stopConfirmationStartedAt: undefined,
        lastUsedAt: now,
        updatedAt: now,
        totalErrors: existing.totalErrors ?? 0,
        timeoutCount: existing.timeoutCount ?? 0,
      } satisfies BackgroundJobRecord;
      this.setJob(updated);
      return updated;
    }

    const record = this.createLaunchRecord(input, now, generation);
    this.setJob(record);
    return record;
  }

  abandonLaunch(
    launched: BackgroundJobRecord,
    replaced: BackgroundJobRecord,
  ): boolean {
    if (
      replaced.taskID !== launched.taskID ||
      this.jobs.get(launched.taskID)?.generation !== launched.generation
    ) {
      return false;
    }
    this.setJob(replaced);
    return true;
  }

  adoptTerminal(
    input: BackgroundJobAdoptionInput,
  ): BackgroundJobRecord | undefined {
    if (this.jobs.has(input.taskID)) return;
    const record: BackgroundJobRecord = {
      ...this.createLaunchRecord(
        { ...input, background: true, adopted: true },
        input.createdAt,
        ++this.executionSequence,
      ),
      state: 'reconciled',
      terminalState: input.terminalState,
      terminalRevision: 1,
      completedAt: input.updatedAt,
      updatedAt: input.updatedAt,
      lastUsedAt: input.updatedAt,
      resultSummary: input.resultSummary,
    };
    this.setJob(record);
    return record;
  }

  private createLaunchRecord(
    input: BackgroundJobLaunchInput,
    now: number,
    generation: number,
  ): BackgroundJobRecord {
    return {
      taskID: input.taskID,
      // Keep the property absent for ordinary launches and legacy records.
      ...(input.provisional === true ? { provisional: true } : {}),
      ...(input.adopted === true || input.provisional === true
        ? { externalOrigin: true as const }
        : input.pluginLaunched === true && input.background === true
          ? { pluginLaunched: true as const }
          : {}),
      generation,
      terminalRevision: 0,
      activityRevision: 0,
      taskGeneration: 1,
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      description: input.description || `background ${input.agent} task`,
      objective: input.objective,
      state: 'running',
      background: input.background === true,
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      cancellationRequested: false,
      terminalUnreconciled: false,
      launchedAt: now,
      lastLaunchedAt: now,
      runStartedAt: now,
      lastLiveBusyAt: now,
      lastUsedAt: now,
      updatedAt: now,
      alias:
        input.adopted || !this.isNumberedAliasReady(input.parentSessionID)
          ? input.taskID
          : this.nextAlias(input.parentSessionID, input.agent),
      contextFiles: [],
      totalErrors: 0,
      timeoutCount: 0,
    };
  }

  updateStatus(
    input: BackgroundJobStatusInput & { state: 'running' },
  ): BackgroundJobRecord | undefined {
    if (input.state !== 'running') return this.jobs.get(input.taskID);
    return this.applyStatus(input);
  }

  commitTerminal(
    input: BackgroundJobTerminalInput,
    token: TerminalCommitToken,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (
      existing?.state !== 'running' ||
      !consumeTerminalCommitToken(this.terminalGate, token, existing, input)
    )
      return existing;
    return this.commitTerminalRecord(input, existing.generation);
  }

  bindTerminalGate(gate: BackgroundJobTerminalGate): void {
    this.terminalGate = gate;
  }

  /** Builders stay private; low-level test fixtures may seed this seam, never
   * manufacture production terminal authorizations. */
  private commitTerminalRecord(
    input: BackgroundJobTerminalInput,
    generation: number,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (existing?.state !== 'running' || existing.generation !== generation)
      return existing;
    if (existing.deadlineExceededAt !== undefined) {
      return this.finalizeWallClockTimeout({
        taskID: input.taskID,
        generation: existing.generation,
        statusUncertain: false,
        resultSummary: input.resultSummary,
        now: input.now,
      });
    }
    if (input.state === 'stopped')
      return this.markStopped(
        input.taskID,
        input.resultSummary,
        Math.max(Date.now(), (existing.lastLiveBusyAt ?? 0) + 1),
        existing.generation,
        input.now,
      );
    if (input.state === 'cancelled')
      return this.markCancelled(input.taskID, input.resultSummary, input.now, {
        force: true,
        expectedGeneration: existing.generation,
        cancellationLease: input.cancellationLease,
      });
    return this.applyStatus({
      ...input,
      state: input.state,
      expectedGeneration: existing.generation,
    });
  }

  private applyStatus(
    input: BackgroundJobStatusInput,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (!existing) return undefined;
    if (
      input.expectedGeneration !== undefined &&
      existing.generation !== input.expectedGeneration
    ) {
      return existing;
    }

    // A wall-clock deadline is a hard, non-recoverable claim. Completion after
    // that claim is late evidence and cannot replace the canonical timeout.
    if (existing.deadlineExceededAt !== undefined) {
      if (existing.state !== 'running') return existing;
      if (input.state === 'completed' || input.state === 'running') {
        return existing;
      }
      return this.finalizeWallClockTimeout({
        taskID: input.taskID,
        generation: existing.generation,
        now: input.now,
        statusUncertain: false,
        resultSummary: existing.resultSummary ?? timeoutSummary(input.state),
      });
    }

    // Guard: stale status updates cannot reopen already terminal jobs.
    if (
      existing.state === 'reconciled' ||
      (existing.state === 'stopped' && input.state === 'running') ||
      (existing.state === 'cancelled' && input.state !== 'cancelled') ||
      (isCanonicalTerminalState(existing.state) && input.state === 'running')
    ) {
      return existing;
    }

    const now = input.now ?? Date.now();
    const terminal = input.state !== 'running';
    const notifyTerminal =
      terminal && !isCanonicalTerminalState(existing.state);
    const updated: BackgroundJobRecord = {
      ...existing,
      state: input.state,
      timedOut: input.timedOut ?? false,
      recoverableAfterLiveBusy:
        input.state !== 'running'
          ? false
          : input.timedOut === true
            ? false
            : existing.recoverableAfterLiveBusy,
      statusUncertain: input.statusUncertain ?? false,
      terminalUnreconciled: terminal ? true : existing.terminalUnreconciled,
      terminalRevision: existing.terminalRevision + (terminal ? 1 : 0),
      updatedAt: now,
      completedAt: terminal
        ? (existing.completedAt ?? now)
        : existing.completedAt,
      terminalState: terminal ? input.state : existing.terminalState,
      resultSummary: input.resultSummary ?? existing.resultSummary,
      lastStatusError: input.lastStatusError,
      stopConfirmationStartedAt:
        input.state === 'running'
          ? existing.stopConfirmationStartedAt
          : undefined,
    };

    if (input.state === 'completed') {
      updated.timeoutCount = 0;
    }
    if (input.state === 'error') {
      updated.totalErrors = (existing.totalErrors ?? 0) + 1;
      updated.lastErrorAt = updated.updatedAt;
    }
    if (input.timedOut && input.state !== 'completed') {
      updated.timeoutCount = (existing.timeoutCount ?? 0) + 1;
    }

    this.setJob(updated);
    this.trimReusable(input.taskID);
    if (notifyTerminal) this.notifyTerminalStateListeners(input.taskID);
    return updated;
  }

  markRunningFromLiveSession(
    taskID: string,
    now = Date.now(),
    expectedGeneration?: number,
    observedTerminalRevision?: number,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }

    if (
      existing.state !== 'running' &&
      existing.completedAt !== undefined &&
      now <= existing.completedAt &&
      observedTerminalRevision !== existing.terminalRevision
    ) {
      const updated: BackgroundJobRecord = {
        ...existing,
        lastLiveBusyAt: now,
      };
      this.setJob(updated);
      return updated;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'running',
      updatedAt: now,
      lastLiveBusyAt: now,
      activityRevision: existing.activityRevision + 1,
      stopConfirmationStartedAt: undefined,
      timedOut: existing.deadlineExceededAt !== undefined,
      recoverableAfterLiveBusy:
        existing.recoverableAfterLiveBusy || existing.timedOut,
      statusUncertain: existing.deadlineExceededAt !== undefined,
      // A live observation restarts the demotion clock.
      statusUncertainSince: undefined,
      terminalUnreconciled: false,
      terminalRevision:
        existing.terminalRevision + (existing.state === 'running' ? 0 : 1),
      completedAt: undefined,
      resultSummary: undefined,
      lastStatusError: undefined,
      terminalState: undefined,
    };

    this.setJob(updated);
    return updated;
  }

  /**
   * The host reports that this child no longer executes, but no native task
   * result established success, cancellation, or failure. Keep that ambiguity
   * visible to the parent and never permit ordinary `task()` reuse. Recovery
   * of the retained session is `task_revive`, not silent spawn.
   */
  private markStopped(
    taskID: string,
    resultSummary: string,
    observedAt = Date.now(),
    expectedGeneration?: number,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    if (existing.deadlineExceededAt !== undefined) return existing;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }
    if (
      existing.lastLiveBusyAt !== undefined &&
      existing.lastLiveBusyAt >= observedAt
    ) {
      return existing;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'stopped',
      terminalRevision: existing.terminalRevision + 1,
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      terminalUnreconciled: true,
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
      resultSummary,
      lastStatusError: undefined,
      stopConfirmationStartedAt: undefined,
    };
    this.setJob(updated);
    this.notifyTerminalStateListeners(taskID);
    return updated;
  }

  noteStopConfirmation(
    taskID: string,
    startedAt: number,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }
    if (existing.stopConfirmationStartedAt !== undefined) return existing;

    const updated: BackgroundJobRecord = {
      ...existing,
      stopConfirmationStartedAt: startedAt,
    };
    this.setJob(updated);
    return updated;
  }

  markStatusUncertain(
    taskID: string,
    lastStatusError: string,
    expectedGeneration?: number,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }
    const updated: BackgroundJobRecord = {
      ...existing,
      statusUncertain: true,
      // Stamp the episode start once; a confirmed observation restarts the
      // clock on re-entry. Paths flagging uncertainty elsewhere leave the
      // stamp unset — the renderer falls back to updatedAt.
      statusUncertainSince: existing.statusUncertain
        ? (existing.statusUncertainSince ?? now)
        : now,
      lastStatusError,
      updatedAt: now,
    };
    this.setJob(updated);
    return updated;
  }

  markReconciled(
    taskID: string,
    now = Date.now(),
    expectedGeneration?: number,
    expectedRevision?: number,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (
      (expectedGeneration !== undefined &&
        existing.generation !== expectedGeneration) ||
      (expectedRevision !== undefined &&
        existing.terminalRevision !== expectedRevision)
    )
      return existing;
    if (
      !existing.terminalUnreconciled &&
      !isCanonicalTerminalState(existing.state)
    ) {
      return undefined;
    }

    if (existing.state === 'stopped') {
      const updated: BackgroundJobRecord = {
        ...existing,
        terminalUnreconciled: false,
        statusUncertain: false,
        updatedAt: now,
        lastUsedAt: now,
      };
      this.setJob(updated);
      this.trimRetained(taskID);
      return updated;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'reconciled',
      terminalUnreconciled: false,
      statusUncertain:
        existing.deadlineExceededAt !== undefined
          ? existing.statusUncertain
          : false,
      updatedAt: now,
      lastUsedAt: now,
      terminalState: existing.terminalState ?? terminalStateOf(existing.state),
    };

    this.setJob(updated);
    this.trimReusable(taskID);
    return updated;
  }

  private markCancelled(
    taskID: string,
    reason?: string,
    now = Date.now(),
    options: {
      force?: boolean;
      expectedGeneration?: number;
      cancellationLease?: BackgroundJobLease;
    } = {},
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (
      options.expectedGeneration !== undefined &&
      existing.generation !== options.expectedGeneration
    ) {
      return existing;
    }
    const activeLease = this.liveLeases.get(taskID);
    if (
      options.cancellationLease !== undefined &&
      (options.cancellationLease.kind !== 'cancellation' ||
        !this.validateLease(options.cancellationLease))
    ) {
      return existing;
    }
    if (
      activeLease !== undefined &&
      (activeLease.kind !== 'cancellation' ||
        options.cancellationLease === undefined ||
        !this.validateLease(options.cancellationLease))
    ) {
      return existing;
    }
    if (existing.deadlineExceededAt !== undefined) {
      if (existing.state !== 'running') return existing;
      return this.finalizeWallClockTimeout({
        taskID,
        generation: existing.generation,
        now,
        statusUncertain: false,
        resultSummary: existing.resultSummary ?? normalizeCancelReason(reason),
      });
    }
    if (!options.force) {
      if (existing.state === 'reconciled') return existing;
      if (isCanonicalTerminalState(existing.state)) return existing;
    }

    const notifyTerminal =
      !isCanonicalTerminalState(existing.state) &&
      existing.state !== 'reconciled';
    const summary = normalizeCancelReason(reason);
    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'cancelled',
      terminalRevision: existing.terminalRevision + 1,
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      cancellationRequested: true,
      terminalUnreconciled: true,
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
      terminalState: 'cancelled',
      resultSummary: summary,
      lastStatusError: undefined,
      stopConfirmationStartedAt: undefined,
    };

    this.setJob(updated);
    if (notifyTerminal) this.notifyTerminalStateListeners(taskID);
    return updated;
  }

  acquireCancellationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    if (
      existing?.generation !== generation ||
      existing.state !== 'running' ||
      this.liveLeases.has(taskID)
    ) {
      return undefined;
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken('cancellation'),
      kind: 'cancellation',
    };
    this.liveLeases.set(taskID, lease);
    return lease;
  }

  acquireRelaunchLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.generation !== generation || this.liveLeases.has(taskID)) {
      return undefined;
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken('relaunch'),
      kind: 'relaunch',
    };
    this.liveLeases.set(taskID, lease);
    return lease;
  }

  acquireMessageLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    if (
      existing?.generation !== generation ||
      existing.state !== 'running' ||
      this.liveLeases.has(taskID)
    ) {
      return undefined;
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken('message'),
      kind: 'message',
    };
    this.liveLeases.set(taskID, lease);
    return lease;
  }

  acquireTerminalNotificationLease(
    taskID: string,
    generation: number,
    terminalRevision?: number,
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    const terminal =
      existing?.state === 'completed' ||
      existing?.state === 'error' ||
      (existing?.state === 'reconciled' &&
        (existing.terminalState === 'completed' ||
          existing.terminalState === 'error'));
    if (
      existing?.generation !== generation ||
      (terminalRevision !== undefined &&
        existing.terminalRevision !== terminalRevision) ||
      !terminal ||
      this.liveLeases.has(taskID)
    ) {
      return undefined;
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken('terminal-notification'),
      kind: 'terminal-notification',
      terminalRevision: existing.terminalRevision,
    };
    this.liveLeases.set(taskID, lease);
    return lease;
  }

  validateLease(lease: BackgroundJobLease): boolean {
    const activeLease = this.liveLeases.get(lease.taskID);
    return (
      activeLease?.token === lease.token &&
      activeLease.generation === lease.generation &&
      activeLease.kind === lease.kind &&
      (lease.kind !== 'terminal-notification' ||
        this.jobs.get(lease.taskID)?.terminalRevision ===
          lease.terminalRevision)
    );
  }

  releaseLease(lease: BackgroundJobLease): boolean {
    const active = this.liveLeases.get(lease.taskID);
    if (
      !active ||
      active.token !== lease.token ||
      active.kind !== lease.kind ||
      active.generation !== lease.generation ||
      active.terminalRevision !== lease.terminalRevision
    )
      return false;
    this.liveLeases.delete(lease.taskID);
    // A lease may have shielded retained-stopped entries from trimRetained
    // while a revive was in flight. Re-apply the retention cap now that the
    // shield is gone so acknowledged stopped records cannot accumulate past
    // the configured limits (guarded to retained stopped records only).
    this.trimRetained(lease.taskID);
    return true;
  }

  get(taskID: string): BackgroundJobRecord | undefined {
    return this.jobs.get(taskID);
  }

  /** True while the board holds a record or a live lease for the task. */
  isTracked(taskID: string): boolean {
    return this.jobs.has(taskID) || this.liveLeases.has(taskID);
  }

  /** Seed/inspect the board-owned lifecycle ledger (tests, lifecycle facade). */
  recordSuppression(
    taskID: string,
    terminal?: {
      state: 'completed' | 'error' | 'cancelled';
      resultSummary: string;
    },
  ): void {
    recordSuppression(this.ledger, taskID, terminal);
  }

  clearSuppression(taskID: string): void {
    clearSuppression(this.ledger, taskID);
  }

  field<K extends keyof BackgroundJobRecord>(
    taskID: string,
    key: K,
  ): BackgroundJobRecord[K] | undefined {
    return this.get(taskID)?.[key];
  }

  isRunning(taskID: string): boolean {
    const job = this.get(taskID);
    return job?.state === 'running';
  }

  isTerminalUnreconciled(taskID: string): boolean {
    const job = this.get(taskID);
    return !!job?.terminalUnreconciled;
  }

  getResultSummary(taskID: string): string | undefined {
    return this.field(taskID, 'resultSummary');
  }

  getLastLiveBusyAt(taskID: string): number | undefined {
    return this.field(taskID, 'lastLiveBusyAt');
  }

  claimWallClockDeadline(
    input: WallClockTimeoutClaimInput,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (
      existing?.state !== 'running' ||
      existing?.generation !== input.generation ||
      existing?.deadlineExceededAt !== undefined
    ) {
      return undefined;
    }

    const now = input.now ?? Date.now();
    const updated: BackgroundJobRecord = {
      ...existing,
      timedOut: true,
      deadlineExceededAt: now,
      cancellationRequested: true,
      statusUncertain: false,
      updatedAt: now,
      resultSummary:
        input.resultSummary ??
        'Background task exceeded its wall-clock deadline; abort requested.',
    };
    this.setJob(updated);
    return updated;
  }

  private finalizeWallClockTimeout(
    input: WallClockTimeoutFinalizeInput,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (!existing) return undefined;
    if (existing.state !== 'running') return existing;
    if (
      existing.generation !== input.generation ||
      existing.deadlineExceededAt === undefined
    ) {
      return undefined;
    }

    const now = input.now ?? Date.now();
    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'error',
      terminalRevision: existing.terminalRevision + 1,
      timedOut: true,
      recoverableAfterLiveBusy: false,
      statusUncertain: input.statusUncertain,
      cancellationRequested: true,
      terminalUnreconciled: true,
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
      terminalState: 'error',
      resultSummary: input.resultSummary,
      lastStatusError: input.statusUncertain
        ? input.resultSummary
        : existing.lastStatusError,
      timeoutCount: (existing.timeoutCount ?? 0) + 1,
      lastErrorAt: now,
      totalErrors: (existing.totalErrors ?? 0) + 1,
      stopConfirmationStartedAt: undefined,
    };
    this.setJob(updated);
    this.notifyTerminalStateListeners(input.taskID);
    return updated;
  }

  getParentSessionID(taskID: string): string | undefined {
    return this.field(taskID, 'parentSessionID');
  }

  getState(taskID: string): BackgroundJobState | undefined {
    return this.field(taskID, 'state');
  }

  resolve(
    parentSessionID: string,
    taskIDOrAlias: string,
  ): BackgroundJobRecord | undefined {
    const value = taskIDOrAlias.trim();
    return this.list(parentSessionID).find(
      (job) => job.taskID === value || job.alias === value,
    );
  }

  resolveReusable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    const job = this.resolve(parentSessionID, taskIDOrAlias);
    if (!job || !isReusable(job, this.maxContextLines)) return undefined;
    if (agent && job.agent !== agent) return undefined;
    return job;
  }

  resolveRecoverable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    const job = this.resolve(parentSessionID, taskIDOrAlias);
    if (!job) return undefined;
    if (agent && job.agent !== agent) return undefined;
    if (
      job.state !== 'running' ||
      !job.recoverableAfterLiveBusy ||
      job.deadlineExceededAt !== undefined
    ) {
      return undefined;
    }
    return job;
  }

  markUsed(parentSessionID: string, key: string, now = Date.now()): void {
    const job = this.resolve(parentSessionID, key);
    if (!job) return;
    // A use must land strictly after the job's completion so the
    // duplicate-spawn guard's escape hatch opens even when the retrieval and
    // the terminal transition share a millisecond.
    const usedAt =
      job.completedAt === undefined ? now : Math.max(now, job.completedAt + 1);
    this.setJob({
      ...job,
      lastUsedAt: usedAt,
      updatedAt: now,
    });
  }

  // ── Mutation notification (sidebar projection) ───────────────────

  /** Every record mutation funnels through here: wake mutation
   * listeners so projections can re-derive cheaply. */
  private setJob(record: BackgroundJobRecord): void {
    this.jobs.set(record.taskID, record);
    this.notifyMutationListeners();
  }

  private deleteJob(taskID: string): void {
    this.jobs.delete(taskID);
    this.notifyMutationListeners();
  }

  taskIDs(): Set<string> {
    return new Set(this.jobs.keys());
  }

  addContext(taskID: string, files: ContextFile[]): void {
    if (files.length === 0) return;
    const job = this.jobs.get(taskID);
    if (!job) return;
    const existing = new Map(job.contextFiles.map((file) => [file.path, file]));
    for (const file of files) {
      const previous = existing.get(file.path);
      if (previous) {
        existing.set(file.path, {
          ...previous,
          lineCount: Math.max(previous.lineCount, file.lineCount),
          lastReadAt: Math.max(previous.lastReadAt, file.lastReadAt),
        });
      } else {
        existing.set(file.path, { ...file });
      }
    }
    const contextFiles = [...existing.values()]
      .filter((file) => file.lineCount >= this.readContextMinLines)
      .sort(
        (a, b) =>
          b.lineCount - a.lineCount ||
          b.lastReadAt - a.lastReadAt ||
          a.path.localeCompare(b.path),
      )
      .slice(0, this.readContextMaxFiles + 1);
    this.setJob({ ...job, contextFiles });
  }

  list(parentSessionID?: string): BackgroundJobRecord[] {
    const jobs = [...this.jobs.values()];
    const filtered = parentSessionID
      ? jobs.filter((job) => job.parentSessionID === parentSessionID)
      : jobs;

    return filtered.sort((a, b) => a.launchedAt - b.launchedAt);
  }

  hasRunningJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (job.state === 'running') return true;
    }
    return false;
  }

  hasRunning(parentSessionID: string): boolean {
    // A placeholder is not delegated work: it must neither gate a human
    // wait nor justify a recovery wake on its own.
    return this.list(parentSessionID).some(
      (job) => !job.provisional && job.state === 'running',
    );
  }

  hasTerminalUnreconciled(parentSessionID: string): boolean {
    return this.list(parentSessionID).some(
      (job) => !job.provisional && job.terminalUnreconciled,
    );
  }

  /** Attributing evidence — the owning call's output or a cross-board
   * adoption — promotes a placeholder into a tracked task without
   * touching its run state. When the caller knows the owning parent, a
   * mismatched record is left untouched. */
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
    const record = this.jobs.get(taskID);
    if (!record?.provisional) return record;
    if (
      expectedParentSessionID !== undefined &&
      record.parentSessionID !== expectedParentSessionID
    ) {
      return record;
    }
    const promoted = metadata
      ? {
          ...record,
          provisional: false,
          agent: metadata.agent || record.agent,
          description: metadata.description || record.description,
          objective: metadata.objective ?? record.objective,
          background: record.background || metadata.background === true,
        }
      : { ...record, provisional: false };
    this.setJob(promoted);
    if (promoted.state !== 'running') {
      // The stop-time notification skipped this record while it was
      // still provisional; the attributed record owes the wake.
      this.notifyTerminalStateListeners(taskID);
    }
    return promoted;
  }

  hasConvergenceSignals(taskID: string, threshold = 3): boolean {
    const job = this.jobs.get(taskID);
    if (!job) return false;
    const errors = job.totalErrors ?? 0;
    const timeouts = job.timeoutCount ?? 0;
    return errors >= threshold || timeouts >= threshold;
  }

  private listReusable(parent?: string): BackgroundJobRecord[] {
    return this.list(parent).filter((j) => isReusable(j, this.maxContextLines));
  }

  /** Sessions the sidebar may surface as navigation destinations: canonical
   *  terminal or stopped. Independent of parent acknowledgment: such a child
   *  is history even while still unreconciled. */
  private listSidebarHistory(parent?: string): BackgroundJobRecord[] {
    return this.list(parent).filter(isSidebarHistory);
  }

  /** Accessible terminal and stopped sessions, grouped for TUI navigation. */
  sidebarHistoryByParentAgent() {
    const byParent = new Map<string, Map<string, ReusableSessionSelection[]>>();
    for (const job of this.listSidebarHistory()) {
      let byAgent = byParent.get(job.parentSessionID);
      if (!byAgent) {
        byAgent = new Map<string, ReusableSessionSelection[]>();
        byParent.set(job.parentSessionID, byAgent);
      }
      const sessions = byAgent.get(job.agent) ?? [];
      sessions.push({
        taskID: job.taskID,
        alias: job.alias,
        terminalState:
          job.state === 'stopped'
            ? 'stopped'
            : (job.terminalState ?? terminalStateOf(job.state) ?? 'completed'),
        completedAt: job.completedAt,
        lastUsedAt: job.lastUsedAt,
      });
      byAgent.set(job.agent, sessions);
    }
    for (const byAgent of byParent.values()) {
      for (const sessions of byAgent.values()) {
        sessions.sort(
          (a, b) =>
            sidebarRecency(b) - sidebarRecency(a) ||
            b.taskID.localeCompare(a.taskID),
        );
      }
    }
    return byParent;
  }

  formatForPromptWithMetadata(
    parentSessionID: string,
    now = Date.now(),
  ): BackgroundJobPromptMetadata | undefined {
    // Keep placeholders resolvable, but out of every operational section
    // and the corresponding terminal-consumption metadata.
    const jobs = this.list(parentSessionID).filter(
      (job) => job.provisional !== true,
    );
    // Long-unconfirmable running jobs leave the render (#1314); the store
    // record survives and a real terminal publication returns the entry.
    const isStaleUncertain = (job: BackgroundJobRecord) =>
      job.state === 'running' &&
      job.statusUncertain &&
      now - (job.statusUncertainSince ?? job.updatedAt) >=
        STATUS_UNCERTAIN_DEMOTE_AFTER_MS;
    const active = jobs.filter(
      (job) =>
        (job.state === 'running' || job.terminalUnreconciled) &&
        !isStaleUncertain(job),
    );
    // Aged ballast leaves the render (#1314 family). Applied only to
    // reusable/retained below — the active filter's exemption is structural.
    const isRenderAgedOut = (job: BackgroundJobRecord) =>
      now - job.lastUsedAt >= AGED_ENTRY_RENDER_TTL_MS;
    // listReusable predates the provisional provenance contract and is
    // unaware of it: without this filter a reconciled completed
    // placeholder would surface in the Reusable Sessions section even
    // though it was never attributed (same exclusion as `jobs` above).
    const reusable = this.listReusable(parentSessionID).filter(
      (job) => job.provisional !== true && !isRenderAgedOut(job),
    );
    const retained = jobs.filter(
      (job) => isRetainedStopped(job) && !isRenderAgedOut(job),
    );
    const acknowledgedFailedSession = reusable.some((job) => {
      const terminal = job.terminalState ?? terminalStateOf(job.state);
      return terminal === 'cancelled' || terminal === 'error';
    });

    if (active.length === 0 && reusable.length === 0 && retained.length === 0) {
      return undefined;
    }

    const text = formatSystemReminder(
      [
        '### Background Job Board',
        'SENTINEL: background-job-board-v2',
        ...(acknowledgedFailedSession
          ? [
              'Acknowledged terminal sessions are reusable by alias for the same specialist/context.',
            ]
          : [
              'Completed or reconciled sessions are reusable by alias for the same specialist/context.',
            ]),
        'Timed-out running sessions are recoverable by alias for safe resume after a live busy signal.',
        ...(acknowledgedFailedSession
          ? [
              'Active, uncertain, or unacknowledged terminal sessions are not reusable.',
            ]
          : ['Cancelled or errored sessions are not reusable.']),
        ...(this.delegationTool === 'task'
          ? [
              'Continue an existing session with task_revive even when it is not listed here. task_result only reads a result and is not required before task_revive.',
            ]
          : [
              'Completed sessions continue with subagent() by exact session id even when they are not listed. Cancelled, errored, and stopped sessions use task_revive.',
            ]),
        ...(retained.length > 0
          ? [
              `Stopped sessions without a terminal result are retained for task_revive, not ${this.delegationTool}().`,
            ]
          : []),
        '',
        '#### Active / Unreconciled',
        ...(active.length > 0 ? active.map(formatJob) : ['- none']),
        '',
        '#### Reusable Sessions',
        ...(reusable.length > 0
          ? reusable.map((job) => this.formatReusableJob(job))
          : ['- none']),
        ...(retained.length > 0
          ? [
              '',
              '#### Retained / Recovery',
              ...retained.map((job) => this.formatRetainedJob(job)),
            ]
          : []),
      ].join('\n'),
    );

    const terminalUnreconciledTaskIDs = active
      .filter((job) => job.terminalUnreconciled)
      .map(({ taskID, generation, terminalRevision }) => ({
        taskID,
        generation,
        terminalRevision,
      }));

    return { text, terminalUnreconciledTaskIDs };
  }

  formatForPrompt(parentSessionID: string, now?: number): string | undefined {
    return this.formatForPromptWithMetadata(parentSessionID, now)?.text;
  }

  clearParent(parentSessionID: string): void {
    // A deleted parent's life ends; a restored copy (export/import emits no
    // session.created) carries numbers this board never issued.
    this.freshParents.delete(parentSessionID);
    for (const job of this.list(parentSessionID)) {
      recordSuppression(this.ledger, job.taskID, terminalResultPayloadOf(job));
      this.deleteJob(job.taskID);
    }
  }

  drop(taskID: string): void {
    const record = this.get(taskID);
    recordSuppression(
      this.ledger,
      taskID,
      record ? terminalResultPayloadOf(record) : undefined,
    );
    this.deleteJob(taskID);
  }

  // ── Lifecycle policy (board = no policy, always close) ───────────

  deferIfRunning(_sessionId: string): boolean {
    return false; // ponytail: safe default - don't close
  }

  retryDeferredClose(_sessionId: string): boolean {
    return false; // Nothing deferred at board level
  }

  clearDeferredClose(_sessionId: string): void {
    // No-op at board level
  }

  /** Single eviction path for the retention trims: suppression, delete,
   * then the optional terminal-session GC listener. Trim eligibility
   * predicates live in the callers; clearParent/drop must not route here
   * (they can evict running/unreconciled records). */
  private evictRecord(entry: BackgroundJobRecord): void {
    recordSuppression(
      this.ledger,
      entry.taskID,
      terminalResultPayloadOf(entry),
    );
    // Snapshot before the delete: the record is gone from this.jobs after.
    const evicted: BackgroundJobEvictedSession = {
      taskID: entry.taskID,
      parentSessionID: entry.parentSessionID,
      agent: entry.agent,
      description: entry.description,
      state: entry.state,
      background: entry.background,
      provisional: entry.provisional === true,
      pluginLaunched: entry.pluginLaunched === true,
      externalOrigin: entry.externalOrigin === true,
      ...(entry.terminalState !== undefined
        ? { terminalState: entry.terminalState }
        : {}),
      ...(entry.resultSummary !== undefined
        ? { resultSummary: entry.resultSummary }
        : {}),
      alias: entry.alias,
      lastUsedAt: entry.lastUsedAt,
    };
    this.deleteJob(entry.taskID);
    if (!this.onEvictedSession) return;
    try {
      this.onEvictedSession(evicted);
    } catch (error) {
      log('Board eviction listener threw', {
        taskID: entry.taskID,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private trimReusable(taskID: string): void {
    const job = this.jobs.get(taskID);
    if (!job) return;

    // Evict sessions exceeding context budget before count cap.
    // Runs regardless of the triggering job's reusability so that a
    // bloated session cleans up after itself (and its peers) on
    // completion. A leased record (a revive in flight) is never evicted.
    for (const entry of this.list(job.parentSessionID)) {
      if (
        entry.agent === job.agent &&
        !this.liveLeases.has(entry.taskID) &&
        !entry.terminalUnreconciled &&
        (entry.terminalState ?? terminalStateOf(entry.state)) !== undefined &&
        sumContextLines(entry) > this.maxContextLines
      ) {
        this.evictRecord(entry);
      }
    }

    // Only apply the count cap when the triggering job is reusable
    if (!isReusable(job, this.maxContextLines)) return;

    const reusable = this.list(job.parentSessionID)
      .filter(
        (candidate) =>
          candidate.agent === job.agent &&
          !this.liveLeases.has(candidate.taskID) &&
          isReusable(candidate, this.maxContextLines),
      )
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const stale of reusable.slice(this.maxReusablePerAgent)) {
      this.evictRecord(stale);
    }
  }

  private trimRetained(taskID: string): void {
    const job = this.jobs.get(taskID);
    if (!job || !isRetainedStopped(job)) return;

    for (const entry of this.list(job.parentSessionID)) {
      if (
        entry.agent === job.agent &&
        isRetainedStopped(entry) &&
        !this.liveLeases.has(entry.taskID) &&
        sumContextLines(entry) > this.maxContextLines
      ) {
        this.evictRecord(entry);
      }
    }

    const retained = this.list(job.parentSessionID)
      .filter(
        (candidate) =>
          candidate.agent === job.agent &&
          isRetainedStopped(candidate) &&
          !this.liveLeases.has(candidate.taskID),
      )
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const stale of retained.slice(this.maxReusablePerAgent)) {
      this.evictRecord(stale);
    }
  }

  private formatReusableJob(job: BackgroundJobRecord): string {
    const terminal = job.terminalState ?? terminalStateOf(job.state);
    const reconciliation = job.terminalUnreconciled
      ? 'unreconciled'
      : 'reconciled';
    const lines = [
      `- ${promptSafe(job.alias)} / ${promptSafe(job.taskID)} / ${promptSafe(job.agent)} / ${promptSafe(terminal ?? job.state)}, ${reconciliation}`,
      `  Objective: ${promptSafe(job.description || job.objective || '')}`,
    ];
    const context = formatContextFiles(
      job.contextFiles,
      this.readContextMaxFiles,
    );
    if (context) lines.push(`  Context read by ${job.alias}: ${context}`);
    return lines.join('\n');
  }

  private formatRetainedJob(job: BackgroundJobRecord): string {
    const lines = [
      `- ${promptSafe(job.alias)} / ${promptSafe(job.taskID)} / ${promptSafe(job.agent)} / stopped, ${REVIVE_ONLY}`,
      `  Objective: ${promptSafe(job.description || job.objective || '')}`,
      ...(this.delegationTool === 'task'
        ? []
        : [
            `  Recovery: no terminal result; recoverable with task_revive, not ${this.delegationTool}()`,
          ]),
    ];
    const context = formatContextFiles(
      job.contextFiles,
      this.readContextMaxFiles,
    );
    if (context) lines.push(`  Context read by ${job.alias}: ${context}`);
    return lines.join('\n');
  }

  /**
   * Insert one absent, unleased host session as an already-terminal cache
   * row. Does not launch, notify, occupy a slot, or allocate an alias.
   * Returns undefined when the row or a lease appeared first.
   */
  restoreRetainedSession(
    input: RestoreRetainedSessionInput,
  ): BackgroundJobRecord | undefined {
    const taskID = input.taskID.trim();
    const parentSessionID = input.parentSessionID.trim();
    const agent = input.agent.trim();
    if (!taskID || !parentSessionID || !agent) return undefined;
    if (
      input.state !== 'completed' &&
      input.state !== 'error' &&
      input.state !== 'cancelled' &&
      input.state !== 'stopped'
    ) {
      return undefined;
    }
    if (this.jobs.has(taskID) || this.liveLeases.has(taskID)) return undefined;

    const requestedAlias = input.alias?.trim();
    let alias = taskID;
    if (requestedAlias && requestedAlias !== taskID) {
      const taken = this.list(parentSessionID).some(
        (job) => job.alias === requestedAlias,
      );
      if (!taken) {
        this.noteTrustedAlias(parentSessionID, agent, requestedAlias);
        alias = requestedAlias;
      }
    }

    const launchedAt = finiteEvidenceTime(input.launchedAt) ?? 0;
    const completedAt = finiteEvidenceTime(input.completedAt);
    const observedAt = completedAt ?? launchedAt;
    const generation = ++this.executionSequence;
    const record: BackgroundJobRecord = {
      taskID,
      parentSessionID,
      agent,
      description: input.description.trim() || `recovered ${agent} session`,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      state: input.state,
      background: input.background === true,
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      cancellationRequested: input.state === 'cancelled',
      terminalUnreconciled: true,
      launchedAt,
      lastLaunchedAt: launchedAt,
      generation,
      terminalRevision: input.state === 'stopped' ? 0 : 1,
      activityRevision: 0,
      taskGeneration: 1,
      runStartedAt: launchedAt,
      updatedAt: observedAt,
      lastUsedAt: observedAt,
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(input.resultSummary !== undefined
        ? { resultSummary: input.resultSummary }
        : {}),
      alias,
      ...(input.state === 'stopped' ? {} : { terminalState: input.state }),
      verifiedRetainedRound: true,
      recoveredWithoutPrompt: true,
      externalOrigin: true,
      contextFiles: [],
      totalErrors: input.state === 'error' ? 1 : 0,
      timeoutCount: 0,
    };
    this.setJob(record);
    return record;
  }

  /** Advance the in-memory counter to a trusted historical value. Does not
   * allocate a new counter. */
  private noteTrustedAlias(
    parentSessionID: string,
    agent: string,
    alias: string,
  ): void {
    const prefix = aliasPrefixForAgent(agent);
    const match = new RegExp(`^${escapeRegExp(prefix)}-([0-9]+)$`).exec(alias);
    if (!match?.[1]) return;
    const counter = Number(match[1]);
    if (!Number.isSafeInteger(counter) || counter < 1) return;
    const key = `${parentSessionID}:${prefix}`;
    if (counter > (this.counters.get(key) ?? 0))
      this.counters.set(key, counter);
  }

  private nextAlias(parentSessionID: string, agent: string): string {
    const prefix = aliasPrefixForAgent(agent);
    const key = `${parentSessionID}:${prefix}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return `${prefix}-${next}`;
  }

  private nextLeaseToken(kind: BackgroundJobLeaseKind): string {
    this.leaseSequence += 1;
    return `background-job-${kind}-lease-${this.leaseSequence}`;
  }
}

function sumContextLines(record: BackgroundJobRecord): number {
  return record.contextFiles.reduce((sum, f) => sum + (f.lineCount ?? 0), 0);
}

function isReusable(
  job: BackgroundJobRecord,
  maxContextLines: number,
): boolean {
  const terminal = job.terminalState ?? terminalStateOf(job.state);
  if (
    terminal === undefined ||
    job.terminalUnreconciled ||
    job.statusUncertain
  ) {
    return false;
  }

  return sumContextLines(job) <= maxContextLines;
}

/** Sidebar history: canonical terminal or stopped, not running or
 *  status-uncertain. Parent acknowledgment is NOT required — the transcript
 *  exists as soon as the child stops. */
function isSidebarHistory(job: BackgroundJobRecord): boolean {
  // Unattributed placeholders stay out of advertised surfaces until
  // attribution (same exclusion as the prompt's reusable section).
  if (job.provisional) return false;
  if (job.statusUncertain) return false;
  if (job.state === 'stopped') return true;
  const terminal = job.terminalState ?? terminalStateOf(job.state);
  return (
    terminal === 'completed' || terminal === 'error' || terminal === 'cancelled'
  );
}

function sidebarRecency(selection: {
  lastUsedAt: number;
  completedAt?: number;
}): number {
  return Math.max(selection.lastUsedAt, selection.completedAt ?? 0);
}

function isRetainedStopped(job: BackgroundJobRecord): boolean {
  return (
    job.state === 'stopped' && !job.terminalUnreconciled && !job.statusUncertain
  );
}

function terminalStateOf(
  state: BackgroundJobState,
): TaskOutputState | undefined {
  return state === 'completed' || state === 'error' || state === 'cancelled'
    ? state
    : undefined;
}

/** Terminal result payload persisted alongside an eviction tombstone: only
 * when the record had already ended with a result, so a post-restart
 * task_revive can surface it instead of re-prompting the child. */
function terminalResultPayloadOf(record: BackgroundJobRecord):
  | {
      state: 'completed' | 'error' | 'cancelled';
      resultSummary: string;
    }
  | undefined {
  const state = record.terminalState ?? terminalStateOf(record.state);
  if (state !== 'completed' && state !== 'error' && state !== 'cancelled') {
    return undefined;
  }
  return record.resultSummary
    ? { state, resultSummary: record.resultSummary }
    : undefined;
}

function isCanonicalTerminalState(
  state: BackgroundJobState,
): state is TaskOutputState {
  return CANONICAL_TERMINAL_STATES.has(state as TaskOutputState);
}

function formatContextFiles(files: ContextFile[], maxFiles: number): string {
  if (maxFiles === 0) return '';
  const shown = files.slice(0, maxFiles);
  const rest = files.length - shown.length;
  const rendered = shown.map(
    (file) => `${promptSafe(file.path)} (${file.lineCount} lines)`,
  );
  return `${rendered.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

function timeoutSummary(state: TaskOutputState): string {
  return `Background task exceeded its wall-clock deadline; abort was observed with child state ${state}.`;
}

const REVIVE_ONLY = 'task_revive only';

function formatJob(job: BackgroundJobRecord): string {
  const isResume = job.lastLaunchedAt !== job.launchedAt;
  // Exclude wall-clock age labels so prompts remain stable between job-state transitions for cache reuse.
  const displayState =
    job.state === 'running' && isResume ? 'running [resumed]' : job.state;
  const status = job.terminalUnreconciled
    ? `${job.state}, unreconciled${
        job.deadlineExceededAt !== undefined ? ', timed out' : ''
      }`
    : job.statusUncertain
      ? `${job.state}${job.timedOut ? ', timed out' : ''}, status uncertain`
      : job.timedOut
        ? `${job.state}, timed out`
        : displayState;
  const lines = [
    `- ${promptSafe(job.alias)} / ${promptSafe(job.taskID)} / ${promptSafe(job.agent)} / ${promptSafe(job.state === 'stopped' ? `${status}, ${REVIVE_ONLY}` : status)}`,
    `  Objective: ${promptSafe(job.description || job.objective || '')}`,
  ];

  if (job.resultSummary && job.terminalUnreconciled) {
    lines.push(`  Result: ${promptSafe(job.resultSummary)}`);
  } else if (job.lastStatusError && job.statusUncertain) {
    lines.push(`  Status: ${promptSafe(job.lastStatusError)}`);
  }

  return lines.join('\n');
}

function singleLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157)}...`;
}

function promptSafe(value: string): string {
  return singleLine(value)
    .replaceAll('\\', '/')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeCancelReason(reason?: string): string {
  const normalized = reason?.replace(/\s+/g, ' ').trim();
  return normalized ? `cancelled: ${normalized}` : 'cancelled';
}

function finiteEvidenceTime(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
