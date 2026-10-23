import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CONTEXT_FILE_CAP,
  DEFAULT_MAX_SESSIONS_PER_AGENT,
  formatSystemReminder,
} from '../config/constants';
import { escapeRegExp } from './agent-variant';
import {
  clearSuppression as clearSuppressionPersisted,
  getPersistedBackgroundChild,
  type PersistedBackgroundChild,
  persistedBackgroundJobState,
  recordPersistedBackgroundChild,
  recordSuppression as recordSuppressionPersisted,
  restorePersistedBackgroundChild,
} from './background-job-persistence';
import {
  type BackgroundJobTerminalGate,
  consumeTerminalCommitToken,
  type TerminalCommitToken,
} from './background-job-terminal-gate';
import { log } from './logger';
import type { TaskOutputState } from './task';

export interface ContextFile {
  path: string;
  lastReadAt: number;
}

export interface BackgroundJobExecution {
  taskID: string;
  generation: number;
  terminalRevision?: number;
}

export type BackgroundJobLeaseKind =
  | 'cancellation'
  | 'relaunch'
  | 'message'
  | 'terminal-notification';

/** Process-local ownership of a remote operation or same-ID relaunch. */
export interface BackgroundJobLease {
  taskID: string;
  generation: number;
  token: string;
  kind: BackgroundJobLeaseKind;
  terminalRevision?: number;
}

/** Metadata for an accessible reusable session selected from the sidebar. */
export interface ReusableSessionSelection {
  taskID: string;
  alias: string;
  terminalState: TaskOutputState | 'stopped';
  completedAt?: number;
  lastUsedAt: number;
}

export type BackgroundJobState = TaskOutputState | 'stopped' | 'reconciled';

export interface BackgroundJobRecord {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  state: BackgroundJobState;
  /** Unattributed lifecycle placeholder, not yet delegated work. */
  provisional?: boolean;
  /** True only when the native task call explicitly supplied background:true. */
  background: boolean;
  timedOut: boolean;
  recoverableAfterLiveBusy: boolean;
  statusUncertain: boolean;
  /** When status became unconfirmable; drives stale-uncertain removal from the board render. */
  statusUncertainSince?: number;
  cancellationRequested: boolean;
  terminalUnreconciled: boolean;
  launchedAt: number;
  lastLaunchedAt: number;
  /** Monotonic run identity. Explicit relaunch/reuse increments it. */
  generation: number;
  /** Publication identity within a run, including withdrawn publications. */
  terminalRevision: number;
  activityRevision: number;
  /** Task-local run identity; unlike generation, unrelated tasks do not affect it. */
  taskGeneration: number;
  /** First launch observation for the current generation. */
  runStartedAt: number;
  updatedAt: number;
  lastLiveBusyAt?: number;
  completedAt?: number;
  resultSummary?: string;
  lastStatusError?: string;
  alias: string;
  lastUsedAt: number;
  terminalState?: TaskOutputState;
  contextFiles: ContextFile[];
  /** In-memory only: this row is a verified old host round, not a live run. */
  verifiedRetainedRound?: true;
  /** Recovery has not sent a prompt; importing a row does not own host work. */
  recoveredWithoutPrompt?: true;
  /** In-memory only: adopted by the startup scan from persisted host state. */
  recoveredAtStartup?: true;
  /**
   * In-memory provenance: this plugin's own tracked native task call launched
   * this record as a fresh background child. Never set for adopted, restored,
   * provisional, or once-provisional records. Gates terminal-session GC.
   */
  pluginLaunched?: true;
  /**
   * Sticky provenance: the host session was adopted, restored, rehydrated,
   * or first seen as an unattributed placeholder, so this plugin cannot
   * prove it created it. Never cleared; blocks pluginLaunched.
   */
  externalOrigin?: true;
}

export interface BackgroundJobBoardOptions {
  maxReusablePerAgent?: number;
  /** Delegation tool name for model-visible recovery guidance: `subagent` on
   * v2 hosts, `task` on v1/default. Only the two retained/recovery wording
   * lines vary; the board stays v1 by default. */
  delegationTool?: string;
  /**
   * Production boards number only parents created while they run (see
   * noteSessionCreated); other parents' new records use the task ID as
   * their alias and creation still succeeds. Default false keeps direct
   * fixtures on the historical immediate counter.
   */
  deferNumberedAliases?: boolean;
  /**
   * Fired after a retention trim (trimReusable/trimRetained) evicts a
   * terminal or retained-stopped record. Never fires for clearParent/drop,
   * which can evict running or unreconciled records. Listener throws are
   * contained.
   */
  onEvictedSession?: (evicted: BackgroundJobEvictedSession) => void;
}

/** Snapshot of a record evicted by a retention trim, captured before the
 * delete. Terminal-session GC removes the underlying host child session. */
export interface BackgroundJobEvictedSession {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  state: BackgroundJobState;
  /** Record was a background launch (foreground task children are false). */
  background: boolean;
  /** Record was still an unattributed session.created placeholder. */
  provisional: boolean;
  /** This plugin's own tracked native task call launched the session. */
  pluginLaunched: boolean;
  /** Session was adopted, restored, rehydrated, or once provisional. */
  externalOrigin: boolean;
  terminalState?: TaskOutputState;
  resultSummary?: string;
  alias: string;
  lastUsedAt: number;
}

/**
 * Terminal-session GC eligibility: only a background, non-provisional record
 * that this plugin's own native task call launched, with no adopted,
 * restored, rehydrated, or placeholder provenance. Everything else keeps its
 * host session.
 */
export function isPrunableEvictedSession(
  evicted: BackgroundJobEvictedSession,
): boolean {
  return (
    evicted.background &&
    !evicted.provisional &&
    evicted.pluginLaunched &&
    !evicted.externalOrigin
  );
}

/** Verified host session placed directly into a terminal retained state.
 * This is a cache observation, not a new model run. */
export interface RestoreRetainedSessionInput {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  state: 'completed' | 'error' | 'cancelled' | 'stopped';
  background: boolean;
  resultSummary?: string;
  /** Trusted historical alias. Omit to display the exact session id. */
  alias?: string;
  /** Evidence timestamp. Omitted values stay 0; never the recovery clock. */
  launchedAt?: number;
  completedAt?: number;
}

export interface BackgroundJobLaunchInput {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description?: string;
  objective?: string;
  background?: boolean;
  /** Only unattributed session.created placeholders opt in. */
  provisional?: true;
  /** An existing host child keeps its task ID; numbers are for new children. */
  adopted?: true;
  /** Preserve the current run when this is a duplicate lifecycle observation. */
  preserveRun?: boolean;
  /**
   * This plugin's own tracked native task call launched a fresh background
   * child (not a resume). Ignored for adopted/provisional input and for
   * records with external provenance.
   */
  pluginLaunched?: true;
  /** Lease proving that this is an authorized same-ID relaunch observation. */
  relaunchLease?: BackgroundJobLease;
  /** Backwards-compatible generic spelling for the relaunch lease. */
  lease?: BackgroundJobLease;
  now?: number;
}

export interface BackgroundJobStatusInput {
  taskID: string;
  state: TaskOutputState;
  /** Ignore native output from an older run of the same task ID. */
  expectedGeneration?: number;
  timedOut?: boolean;
  statusUncertain?: boolean;
  resultSummary?: string;
  lastStatusError?: string;
  now?: number;
}

export interface BackgroundJobAdoptionInput {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  terminalState: 'completed' | 'error';
  resultSummary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BackgroundJobTerminalInput {
  taskID: string;
  state: 'completed' | 'error' | 'cancelled' | 'stopped';
  resultSummary: string;
  cancellationLease?: BackgroundJobLease;
  now?: number;
}

type MutationListener = () => void;

/** Canonical terminal publication delivered to outcome subscribers. */
export type TerminalOutcomeListener = (record: BackgroundJobRecord) => void;

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

/** Alias↔session projection consumer. Best-effort: throws are contained. */
export type LaunchIdentityListener = (
  event: BackgroundJobIdentityEvent,
) => void;

export type BackgroundJobSyntheticTerminalOccurrencePhase =
  | 'observed'
  | 'processed'
  | 'ambiguous';

export interface BackgroundJobSyntheticTerminalOccurrence {
  taskID: string;
  occurrenceID: string;
  generationAtObservation?: number;
  lifecycleEpochAtObservation: number;
  phase: BackgroundJobSyntheticTerminalOccurrencePhase;
}

export interface BackgroundJobInjectedCompletionFence {
  taskID: string;
  generation: number;
  lifecycleEpoch: number;
}

/**
 * Process-local lifecycle memory shared by every consumer of one board.
 *
 * These sets/maps intentionally have no count cap. Evicting an old identity
 * would turn a replay of valid history into a false negative for the current
 * generation. The ledger is process-local by design; it is not persistence.
 */
export interface BackgroundJobLifecycleLedger {
  tombstones: Set<string>;
  deletionEpochs: Map<string, number>;
  injectedCompletionFences: Map<string, BackgroundJobInjectedCompletionFence>;
  syntheticTerminalOccurrences: Map<
    string,
    BackgroundJobSyntheticTerminalOccurrence
  >;
  syntheticTerminalOccurrenceOrder: string[];
  processedInjectedCompletions: Set<string>;
  processedInjectedCompletionOrder: string[];
  nextEpoch: number;
}

/**
 * One ledger per board instance: boards are constructed independently by
 * tests, fixtures, and the plugin, and must not share lifecycle memory.
 */
const lifecycleLedgers = new WeakMap<object, BackgroundJobLifecycleLedger>();

/**
 * Seed a freshly created ledger from backend-loaded persistence state.
 * No-op without a configured storage backend (v1 / hosts without the
 * domain) — fresh ledgers then stay exactly as process-local as before.
 */
function seedFromPersistence(ledger: BackgroundJobLifecycleLedger): void {
  const snapshot = persistedBackgroundJobState();
  if (snapshot.tombstones.size === 0 && snapshot.deletionEpochs.size === 0) {
    return;
  }
  for (const [taskID, record] of snapshot.tombstones) {
    ledger.tombstones.add(taskID);
    ledger.deletionEpochs.set(taskID, record.epoch);
  }
  for (const [taskID, epoch] of snapshot.deletionEpochs) {
    if (!ledger.deletionEpochs.has(taskID)) {
      ledger.deletionEpochs.set(taskID, epoch);
    }
  }
  if (snapshot.nextEpoch > ledger.nextEpoch) {
    ledger.nextEpoch = snapshot.nextEpoch;
  }
}

export function getBackgroundJobLifecycleLedger(
  board: object,
): BackgroundJobLifecycleLedger {
  const existing = lifecycleLedgers.get(board);
  if (existing) return existing;

  const ledger: BackgroundJobLifecycleLedger = {
    tombstones: new Set<string>(),
    deletionEpochs: new Map<string, number>(),
    injectedCompletionFences: new Map(),
    syntheticTerminalOccurrences: new Map(),
    syntheticTerminalOccurrenceOrder: [],
    processedInjectedCompletions: new Set<string>(),
    processedInjectedCompletionOrder: [],
    nextEpoch: 0,
  };
  seedFromPersistence(ledger);
  lifecycleLedgers.set(board, ledger);
  return ledger;
}

/** Record a task drop/eviction as a rehydrate and late-output tombstone.
 * Write-through: the persisted tombstone (and its deletion epoch) is
 * updated together with the in-memory ledger so the two can never
 * diverge across a restart. Cleared only by clearBackgroundJobSuppression
 * via registerLaunch — an explicit (re)launch/adoption is proof of life;
 * the deletion epoch intentionally survives for generation fencing. */
export function recordBackgroundJobSuppression(
  board: object,
  taskID: string,
  terminal?: {
    state: 'completed' | 'error' | 'cancelled';
    resultSummary: string;
  },
): void {
  const ledger = getBackgroundJobLifecycleLedger(board);
  if (ledger.tombstones.has(taskID)) return;
  ledger.tombstones.add(taskID);
  const epoch = ++ledger.nextEpoch;
  ledger.deletionEpochs.set(taskID, epoch);
  recordSuppressionPersisted(taskID, epoch, terminal);
}

/** Clear only the active rehydrate tombstone for a proven new launch.
 * Write-through: clearing on relaunch is load-bearing — a task deleted
 * then legitimately relaunched must NOT be ghost-skipped after a
 * restart. The deletion epoch intentionally survives (generation
 * fencing), matching the in-memory ledger semantics. */
export function clearBackgroundJobSuppression(
  board: object,
  taskID: string,
): void {
  getBackgroundJobLifecycleLedger(board).tombstones.delete(taskID);
  clearSuppressionPersisted(taskID);
}

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
  observer: 'obs',
  oracle: 'ora',
};

/** Numbered-alias prefix for an agent. Unknown agents use a 3-letter fallback. */
function aliasPrefixForAgent(agent: string): string {
  return AGENT_PREFIX[agent] ?? (agent.slice(0, 3) || 'job');
}

export class BackgroundJobBoard {
  private terminalGate?: BackgroundJobTerminalGate;
  private readonly jobs = new Map<string, BackgroundJobRecord>();
  /** Persisted identity overwritten by a launch that may still be refused. */
  private readonly launchPersistenceSnapshots = new WeakMap<
    BackgroundJobRecord,
    PersistedBackgroundChild | undefined
  >();
  /** One live operation/relaunch owner per native session ID. */
  private readonly liveLeases = new Map<string, BackgroundJobLease>();
  private readonly counters = new Map<string, number>();
  /**
   * The board's single numeric counter: the monotonic run ordinal that
   * backs every record's `generation`. Lease tokens no longer consume a
   * counter: they are opaque unique ids, so a stale lease can never share
   * a token with a reissued lease of the same run.
   */
  private executionSequence = 0;
  private mutationListeners: MutationListener[] = [];
  private terminalOutcomeListeners: TerminalOutcomeListener[] = [];
  private launchIdentityListeners: LaunchIdentityListener[] = [];

  private readonly maxReusablePerAgent: number;
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

  /** Observe every canonical terminal publication, including non-idle jobs. */
  addTerminalOutcomeListener(listener: TerminalOutcomeListener): void {
    this.terminalOutcomeListeners.push(listener);
  }

  removeTerminalOutcomeListener(listener: TerminalOutcomeListener): void {
    this.terminalOutcomeListeners = this.terminalOutcomeListeners.filter(
      (entry) => entry !== listener,
    );
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

  /** Subscribe to ANY board mutation (set/delete/trim/drop). The listener
   * receives no payload: re-derive from the board's read-only queries. */
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

  /**
   * Single-owner seam for a canonical terminal publication: the board owns
   * the single internal notification and fans out to outcome subscribers.
   * State is re-checked here to handle races.
   */
  private notifyTerminalPublication(taskID: string): void {
    // Nothing observes this board's publications: stay silent, exactly as the
    // pre-merge board was before a coordinator installed its handler.
    if (this.terminalOutcomeListeners.length === 0) return;

    // Re-check board state to handle races
    const state = this.getState(taskID);
    if (state === undefined) return; // Job was already cleaned up

    const record = this.get(taskID);
    if (!record) return;
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

  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord {
    const record = this.insertLaunchRecord(input);
    this.notifyLaunchIdentity({
      kind: 'registered',
      taskID: record.taskID,
      parentSessionID: record.parentSessionID,
      agent: record.agent,
      alias: record.alias,
    });
    return record;
  }

  /** State transition for an accepted launch; throws when the host has
   * refused it. The identity projection fires only for accepted records. */
  private insertLaunchRecord(
    input: BackgroundJobLaunchInput,
  ): BackgroundJobRecord {
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
        throw new Error(
          `Cannot register launch for ${input.taskID}: the relaunch lease is missing, stale, or belongs to another generation`,
        );
      }
    }

    if (liveLease) {
      if (
        liveLease.kind !== 'relaunch' ||
        requestedLease === undefined ||
        !this.validateLease(requestedLease)
      ) {
        throw new Error(
          `Cannot register launch for ${input.taskID}: a ${liveLease.kind} lease already owns this session`,
        );
      }
    }

    clearBackgroundJobSuppression(this, input.taskID);
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
          this.notifyTerminalPublication(input.taskID);
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
        this.persistBackgroundChild(observed, { preserveDelivered: true });
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
        lastLiveBusyAt: now,
        lastUsedAt: now,
        updatedAt: now,
      } satisfies BackgroundJobRecord;
      this.setJob(updated);
      this.persistBackgroundChild(updated, {});
      return updated;
    }

    const record = this.createLaunchRecord(input, now, generation);
    this.setJob(record);
    this.persistBackgroundChild(record, {});
    return record;
  }

  private persistBackgroundChild(
    record: BackgroundJobRecord,
    options: { preserveDelivered?: boolean },
  ): void {
    if (!record.background || record.state !== 'running') return;
    // Capture what this write replaces. A refused relaunch restores it,
    // including its delivered marker, instead of leaving the rejected
    // launch as a phantom persisted run.
    this.launchPersistenceSnapshots.set(
      record,
      getPersistedBackgroundChild(record.taskID),
    );
    recordPersistedBackgroundChild(
      {
        taskID: record.taskID,
        parentSessionID: record.parentSessionID,
        agent: record.agent,
        description: record.description,
        ...(record.objective !== undefined
          ? { objective: record.objective }
          : {}),
        launchedAt: record.runStartedAt,
        background: true,
      },
      { preserveDelivered: options.preserveDelivered === true },
    );
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
    if (this.launchPersistenceSnapshots.has(launched)) {
      restorePersistedBackgroundChild(
        launched.taskID,
        this.launchPersistenceSnapshots.get(launched),
      );
      this.launchPersistenceSnapshots.delete(launched);
    }
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
    };

    this.setJob(updated);
    this.trimReusable(input.taskID);
    if (notifyTerminal) this.notifyTerminalPublication(input.taskID);
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
      launchedAt: existing.state === 'running' ? existing.launchedAt : now,
      // A terminal/reconciled row observed live again is a genuinely new
      // execution: the per-run fence must move with it. Repeated busy
      // observations of an in-flight run keep the existing fence.
      runStartedAt: existing.state === 'running' ? existing.runStartedAt : now,
      lastLiveBusyAt: now,
      activityRevision: existing.activityRevision + 1,
      timedOut: false,
      recoverableAfterLiveBusy:
        existing.recoverableAfterLiveBusy || existing.timedOut,
      statusUncertain: false,
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
    if (existing.state !== 'running') {
      // A self-continued or directly prompted child starts a new live run.
      // Clear the prior terminal delivery marker; passive observations must
      // keep it so a completed child cannot replay a wake after restart.
      this.persistBackgroundChild(updated, {});
    }
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
    };
    this.setJob(updated);
    this.notifyTerminalPublication(taskID);
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
      statusUncertain: false,
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
    if (!options.force) {
      if (existing.state === 'reconciled') return existing;
      if (isCanonicalTerminalState(existing.state)) return existing;
    }

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
    };

    this.setJob(updated);
    this.notifyTerminalPublication(taskID);
    return updated;
  }

  /**
   * The single ownership entry point: at most one live lease exists per
   * native session ID regardless of kind (cancellation, message, relaunch,
   * terminal-notification), enforcing the single-owner rule for
   * plugin-initiated lifecycle operations. The kind label stays in the
   * lease and in refusal wording; only the acquisition machinery is
   * collapsed. Per-kind record-state preconditions:
   * - cancellation/message: the run must be live;
   * - relaunch: any state (it authorizes a same-ID relaunch observation);
   * - terminal-notification: a completed/error publication, optionally
   *   pinned to an exact terminalRevision; the lease then carries it so a
   *   later revision invalidates the lease.
   */
  acquireLease(
    taskID: string,
    generation: number,
    kind: BackgroundJobLeaseKind,
    options?: { terminalRevision?: number },
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    if (
      !existing ||
      existing.generation !== generation ||
      this.liveLeases.has(taskID)
    ) {
      return undefined;
    }
    if (kind === 'cancellation' || kind === 'message') {
      if (existing.state !== 'running') return undefined;
    } else if (kind === 'terminal-notification') {
      const terminal =
        existing.state === 'completed' ||
        existing.state === 'error' ||
        (existing.state === 'reconciled' &&
          (existing.terminalState === 'completed' ||
            existing.terminalState === 'error'));
      if (
        !terminal ||
        (options?.terminalRevision !== undefined &&
          existing.terminalRevision !== options.terminalRevision)
      ) {
        return undefined;
      }
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken(kind),
      kind,
      ...(kind === 'terminal-notification'
        ? { terminalRevision: existing.terminalRevision }
        : {}),
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
    if (!job || !isReusable(job)) return undefined;
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
    if (job.state !== 'running' || !job.recoverableAfterLiveBusy) {
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
          lastReadAt: Math.max(previous.lastReadAt, file.lastReadAt),
        });
      } else {
        existing.set(file.path, { ...file });
      }
    }
    const contextFiles = [...existing.values()]
      .sort(
        (a, b) => b.lastReadAt - a.lastReadAt || a.path.localeCompare(b.path),
      )
      .slice(0, DEFAULT_CONTEXT_FILE_CAP + 1);
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
      this.notifyTerminalPublication(taskID);
    }
    return promoted;
  }

  private listReusable(parent?: string): BackgroundJobRecord[] {
    return this.list(parent).filter((j) => isReusable(j));
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

  clearParent(parentSessionID: string): void {
    // A deleted parent's life ends; a restored copy (export/import emits no
    // session.created) carries numbers this board never issued.
    this.freshParents.delete(parentSessionID);
    // Capture identities before the board removes them so the projection
    // can retract aliases for every affected record.
    const removed = this.list(parentSessionID);
    for (const job of removed) {
      recordBackgroundJobSuppression(
        this,
        job.taskID,
        terminalResultPayloadOf(job),
      );
      this.deleteJob(job.taskID);
    }
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
    const record = this.get(taskID);
    recordBackgroundJobSuppression(
      this,
      taskID,
      record ? terminalResultPayloadOf(record) : undefined,
    );
    this.deleteJob(taskID);
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

  /** Single eviction path for the retention trims: suppression, delete,
   * then the optional terminal-session GC listener. Trim eligibility
   * predicates live in the callers; clearParent/drop must not route here
   * (they can evict running/unreconciled records). */
  private evictRecord(entry: BackgroundJobRecord): void {
    recordBackgroundJobSuppression(
      this,
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

    // Only apply the count cap when the triggering job is reusable
    if (!isReusable(job)) return;

    const reusable = this.list(job.parentSessionID)
      .filter(
        (candidate) =>
          candidate.agent === job.agent &&
          !this.liveLeases.has(candidate.taskID) &&
          isReusable(candidate),
      )
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const stale of reusable.slice(this.maxReusablePerAgent)) {
      this.evictRecord(stale);
    }
  }

  private trimRetained(taskID: string): void {
    const job = this.jobs.get(taskID);
    if (!job || !isRetainedStopped(job)) return;

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

  /**
   * Correct a running row that startup recovery had adopted before the
   * child was verified terminal. The caller owns publication; this method
   * deliberately fires no terminal listener so a restart cannot double
   * wake the parent.
   */
  correctStartupRecoveredTerminal(input: {
    taskID: string;
    generation: number;
    state: 'completed' | 'error' | 'cancelled' | 'stopped';
    resultSummary?: string;
    now?: number;
  }): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (
      existing?.state !== 'running' ||
      existing.generation !== input.generation ||
      existing.externalOrigin !== true
    ) {
      return existing;
    }
    const now = input.now ?? Date.now();
    const updated: BackgroundJobRecord = {
      ...existing,
      state: input.state,
      terminalUnreconciled: true,
      terminalRevision:
        input.state === 'stopped'
          ? existing.terminalRevision
          : existing.terminalRevision + 1,
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
      terminalState: input.state === 'stopped' ? undefined : input.state,
      ...(input.resultSummary !== undefined
        ? { resultSummary: input.resultSummary }
        : {}),
      statusUncertain: false,
      statusUncertainSince: undefined,
      lastStatusError: undefined,
      verifiedRetainedRound: true,
      recoveredAtStartup: true,
    };
    // Startup delivery marks the identity after its wake callback so a
    // failed callback can be retried on the next restart.
    this.setJob(updated);
    return updated;
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
    };
    this.setJob(record);
    this.notifyLaunchIdentity({
      kind: 'registered',
      taskID: record.taskID,
      parentSessionID: record.parentSessionID,
      agent: record.agent,
      alias: record.alias,
    });
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
    return `background-job-${kind}-lease-${randomUUID()}`;
  }
}

export function deriveTaskSessionLabel(input: {
  description?: string;
  prompt?: string;
  agentType: string;
}): string {
  const preferred = normalizeWhitespace(input.description ?? '');
  if (preferred) return preferred.slice(0, 48);
  const firstPromptLine = (input.prompt ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  return firstPromptLine
    ? firstPromptLine.slice(0, 48)
    : `recent ${input.agentType} task`;
}
/**
 * Full objective text before deriveTaskSessionLabel truncates it: the
 * whitespace-normalized description, else the first non-empty prompt line.
 * Board records store this untruncated so the duplicate-spawn guard can
 * match long exact duplicates without colliding on shared 48-char prefixes.
 */
export function deriveFullObjective(input: {
  description?: string;
  prompt?: string;
}): string | undefined {
  const preferred = normalizeWhitespace(input.description ?? '');
  if (preferred) return preferred;
  const firstPromptLine = (input.prompt ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  return firstPromptLine ?? undefined;
}

function isReusable(job: BackgroundJobRecord): boolean {
  const terminal = job.terminalState ?? terminalStateOf(job.state);
  return (
    terminal !== undefined && !job.terminalUnreconciled && !job.statusUncertain
  );
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
