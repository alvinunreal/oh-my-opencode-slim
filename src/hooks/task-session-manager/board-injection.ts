/**
 * Terminal-observation subsystem for the task session manager.
 *
 * The Background Job Board is never rendered (issue #1647): this module
 * observes delivery facts already present in the parent's history (host
 * native completions, the plugin's own tagged `<completed-job>` pushes) and
 * retires the terminal runs they report.
 *
 * All injection logic must go through the cache-safe helpers in
 * ../cache-safe-injection.ts to ensure prompt cache safety.
 */
import { createHash } from 'node:crypto';
import { formatSystemReminder } from '../../config/constants';
import type {
  BackgroundJobBoard,
  BackgroundJobExecution,
  BackgroundJobInjectedCompletionFence,
  BackgroundJobLifecycleLedger,
  BackgroundJobRecord,
  BackgroundJobSyntheticTerminalOccurrence,
  BackgroundJobSyntheticTerminalOccurrencePhase,
  ContextFile,
  TaskStatusOutput,
} from '../../utils';
import {
  isInternalInitiatorPart,
  parseTaskOutputHeader,
  parseTaskStatusOutput,
  renderRunningTaskPlaceholder,
  TERMINAL_DELTA_METADATA_KEY,
} from '../../utils';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  appendTrailingVolatileMessage,
  isTaggedPart,
} from '../cache-safe-injection';
import type { MessagePart, MessageWithParts } from '../types';
import { isMessageWithParts, isUserMessageWithParts } from '../types';
import {
  messageCreatedAt,
  NATIVE_DELIVERY_STATES,
  type NativeDelivery,
  parseNativeDelivery,
} from './native-delivery';
import { extractTaskSummary, isLateCancelledTaskError } from './status-utils';

// ── Constants ──────────────────────────────────────────────────────────

export const BACKGROUND_JOB_BOARD_METADATA_KEY =
  'oh-my-opencode-slim.backgroundJobBoard';

const BACKGROUND_COMPLETION_COMPLETED = /^Background task completed: /;
const BACKGROUND_COMPLETION_FAILED = /^Background task failed: /;
const loggedMissingTaskStatus = new Set<string>();

// ── State shape ────────────────────────────────────────────────────────

export type InjectedCompletionFence = BackgroundJobInjectedCompletionFence;

export type SyntheticTerminalOccurrencePhase =
  BackgroundJobSyntheticTerminalOccurrencePhase;

export type SyntheticTerminalOccurrenceOrigin =
  BackgroundJobSyntheticTerminalOccurrence;

type SyntheticTerminalOccurrenceLookup =
  | {
      kind: 'matched';
      origin: SyntheticTerminalOccurrenceOrigin;
    }
  | {
      kind: 'ambiguous';
      reason: string;
    };

type SyntheticTerminalProvenanceKind = 'explicit' | 'host-message' | 'legacy';

/** A terminal run the parent consumed (reconciled): reused to detect a
 * reopen-to-running of the same run, which needs a corrective notice. */
type ReportedTerminalRun = {
  taskID: string;
  generation: number;
  /** Terminal state the parent saw (completed | error | cancelled). */
  terminalState?: string;
};

/** A corrective notice delivered on the parent's next eligible request. */
type ReopenCorrection = {
  taskID: string;
  generation: number;
  alias: string;
  priorTerminalState: string;
};

function reportedRunKey(taskID: string, generation: number): string {
  return `${taskID}:${generation}`;
}

/** Corrective notice for a reconciled job that reopened to running: same
 * facts, with the pointer at the pull channel (`task_status`). The
 * correction itself is a staleness notice, not board status — the native
 * notifier covers terminal publications, not the reopen-to-running
 * transition (#1314's anti-narration scope is board status lines). */
export function formatReopenCorrectionText(
  correction: ReopenCorrection,
): string {
  return formatSystemReminder(
    [
      '### Background Job — Reopened',
      'A background job that previously reported a terminal result is running again; the earlier report is superseded.',
      `- ${correction.alias} / ${correction.taskID} / run ${correction.generation} / previously ${correction.priorTerminalState}, now running`,
      'Check `task_status` for the current state before acting on the earlier result.',
    ].join('\n'),
  );
}

/** Record that the parent consumed (reconciled) a terminal run, so a later
 * reopen-to-running of the same run can be corrected. */
function rememberReportedTerminalRun(
  state: InjectionState,
  parentSessionID: string,
  run: ReportedTerminalRun,
): void {
  const reported = state.reportedTerminalRunsByParent?.get(parentSessionID);
  if (reported) {
    reported.set(reportedRunKey(run.taskID, run.generation), run);
    return;
  }
  const map = new Map<string, ReportedTerminalRun>([
    [reportedRunKey(run.taskID, run.generation), run],
  ]);
  if (state.reportedTerminalRunsByParent) {
    state.reportedTerminalRunsByParent.set(parentSessionID, map);
  } else {
    state.reportedTerminalRunsByParent = new Map([[parentSessionID, map]]);
  }
}

/**
 * Deliver corrections for reported runs that reopened to running. Retire
 * delivered runs and prune runs whose job left the board or was superseded by
 * a newer generation. Called at injection time to reflect the current board
 * without a separate event seam on the board store.
 */
function deliverReopenCorrections(
  state: InjectionState,
  parentSessionID: string,
  messages: unknown[],
  baseInfo: MessageWithParts['info'],
): void {
  const reported = state.reportedTerminalRunsByParent?.get(parentSessionID);
  if (!reported || reported.size === 0) return;
  for (const [key, run] of reported) {
    const record = state.backgroundJobBoard.get(run.taskID);
    if (record?.generation === run.generation && record.state !== 'running') {
      continue;
    }
    reported.delete(key);
    if (!record || record.generation !== run.generation) continue;

    const correction: ReopenCorrection = {
      taskID: run.taskID,
      generation: run.generation,
      alias: record.alias,
      priorTerminalState: run.terminalState ?? 'completed',
    };
    log('[task-session-manager] queued reopen corrective notice', {
      parentSessionID,
      taskID: run.taskID,
      generation: run.generation,
      priorTerminalState: correction.priorTerminalState,
    });
    appendTrailingVolatileMessage(
      messages,
      {
        ...baseInfo,
        id: `${baseInfo.id ?? 'board'}-reopen-correction:${key}`,
      },
      {
        text: formatReopenCorrectionText(correction),
        metadataKey: state.metadataKey,
        extraMetadata: { reopenCorrection: true },
      },
    );
  }
  if (reported.size === 0) {
    state.reportedTerminalRunsByParent?.delete(parentSessionID);
  }
}

/**
 * Prune reopen-correction bookkeeping for a parent session (session end).
 * Reported runs must never surface in a recreated session.
 */
export function pruneReopenCorrectionState(
  state: InjectionState,
  parentSessionID: string,
): void {
  state.reportedTerminalRunsByParent?.delete(parentSessionID);
  // Delivery keys are content-addressed, so a stale key can never
  // mis-retire a recreated session — but retaining them leaks memory for
  // dead parents. Keys for a recreated session are fresh message IDs.
  state.observedNativeDeliveries?.delete(parentSessionID);
}

const HOST_MESSAGE_OCCURRENCE_PREFIX = 'host-message:';

export interface InjectionState {
  backgroundJobBoard: BackgroundJobBoard;
  terminalGate: BackgroundJobTerminalGate;
  lifecycleLedger: BackgroundJobLifecycleLedger;
  /**
   * Whether a completed-job push for this exact run is still queued and
   * UNDELIVERED in the wake scheduler. The stale-timestamp fallback must not
   * retire such a run: its own push is the delivery, and acking it first
   * would make the delivery fence reject the queued answer forever
   * (Greptile P1 4344212799). Absent (tests) means no probe.
   */
  hasUndeliveredTerminalPush?: (
    parentSessionID: string,
    taskID: string,
    generation: number,
  ) => boolean;
  processedInjectedCompletions: Set<string>;
  processedInjectedCompletionOrder: string[];
  /**
   * Completion occurrences persist with the board so a recreated hook cannot
   * replay an old synthetic result into a newer task generation.
   */
  injectedCompletionFences?: Map<string, InjectedCompletionFence>;
  /**
   * Synthetic terminal parts observed by the runtime event stream. This is
   * separate from processed fences because an event may arrive before the
   * message transform that consumes the part.
   */
  syntheticTerminalOccurrences?: Map<string, SyntheticTerminalOccurrenceOrigin>;
  syntheticTerminalOccurrenceOrder?: string[];
  getLifecycleEpoch?: () => number;
  getDeletionEpoch?: (taskID: string) => number | undefined;
  /**
   * Native v2 delivery parts already consumed by the observer
   * (`reconcileObservedNativeDeliveries`), keyed by parent session, then by
   * the delivery part's own message/part identity (byte-stable, persisted in
   * history) — never by prompt shape. Keys are consumed only once the
   * delivery can actually act (retire, or is provably stale vs
   * lastLaunchedAt, or its record already reconciled), so a delivery
   * observed while its record is still running retries on the next
   * transform. Per parent the keys are an LRU (cap
   * `NATIVE_DELIVERY_SEEN_CAP`): re-observation refreshes recency and the
   * oldest key is evicted, so a pathological history cannot grow the set
   * without bound while the deliveries a parent's history actually still
   * replays stay remembered. An eviction only re-opens the one-shot pairing
   * window for the oldest keys, which the reopen gate and the stale-terminal
   * fallback still cover. The whole per-parent set dies with the parent at
   * session end (pruneReopenCorrectionState). Optional for states built
   * before the field existed.
   */
  observedNativeDeliveries?: Map<string, Map<string, true>>;
  /** Host flavor marker ('v2' on OpenCode v2 hosts). Both hosts are
   *  structurally boardless: observation-based retirement plus reopen
   *  corrections only. */
  hostFlavor?: string;
  /**
   * Terminal runs this parent has already consumed (reconciled through
   * `reconcileExecutionBatch`), keyed `${taskID}:${generation}`. Used to
   * detect a reconciled job REOPENING to running (typically a child session
   * resumed by its own background-shell notification): the parent's
   * conversation still carries the earlier terminal report, so the reopen
   * needs a corrective trailing notice. Delivered runs and superseded
   * generations are retired on the next eligible request. Optional for
   * states built before the field existed.
   */
  reportedTerminalRunsByParent?: Map<string, Map<string, ReportedTerminalRun>>;
  metadataKey: string;
  shouldManageSession: (sessionID: string) => boolean;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sha256Hash(str: string): string {
  return createHash('sha256').update(str).digest('hex');
}

function createOccurrenceId(
  part: MessagePart,
  message: MessageWithParts,
  partIndex: number,
): string {
  const explicitOccurrenceID = getExplicitOccurrenceID(part);
  if (explicitOccurrenceID) {
    return explicitOccurrenceID;
  }

  const sessionID = message.info.sessionID ?? 'unknown';
  const content = typeof part.text === 'string' ? part.text : '';

  const status = parseTaskStatusOutput(content);
  if (status) {
    const messageID = getCanonicalHostMessageID(part, message);
    if (messageID) {
      return hostMessageOccurrenceID(messageID, status.taskID, content);
    }

    if (typeof message.info.id === 'string') {
      return `${message.info.id}:${partIndex}`;
    }

    const stableKey = `${sessionID}:${status.taskID}:${status.state}:${status.result ?? ''}`;
    const hash = djb2Hash(stableKey);
    return `anon:${hash}`;
  }

  if (typeof message.info.id === 'string') {
    return `${message.info.id}:${partIndex}`;
  }

  const hash = djb2Hash(`${sessionID}:${content}`);
  return `anon:${hash}`;
}

function injectedCompletionKey(
  taskID: string,
  occurrenceId: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
): string {
  return `${provenanceKind}\u001f${taskID}\u001f${occurrenceId}`;
}

function hasProvenanceKind(
  key: string,
  taskID: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
): boolean {
  return key.startsWith(`${provenanceKind}\u001f${taskID}\u001f`);
}

function getExplicitOccurrenceID(part: MessagePart): string | undefined {
  for (const key of ['occurrenceID', 'occurrenceId', 'id']) {
    const value = part[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function getHostMessageID(part: MessagePart): string | undefined {
  return typeof part.messageID === 'string' && part.messageID.trim() !== ''
    ? part.messageID
    : undefined;
}

function getCanonicalHostMessageID(
  part: MessagePart,
  message?: MessageWithParts,
): string | undefined {
  return (
    getHostMessageID(part) ??
    (typeof message?.info.id === 'string' && message.info.id.trim() !== ''
      ? message.info.id
      : undefined)
  );
}

function hostMessageOccurrenceID(
  messageID: string,
  taskID: string,
  terminalPayload: string,
): string {
  return `${HOST_MESSAGE_OCCURRENCE_PREFIX}${djb2Hash(
    `${messageID}:${taskID}`,
  )}:${sha256Hash(terminalPayload)}`;
}

function provenanceKindForPart(
  part: MessagePart,
  message?: MessageWithParts,
): SyntheticTerminalProvenanceKind {
  if (getExplicitOccurrenceID(part)) return 'explicit';
  return getCanonicalHostMessageID(part, message) ? 'host-message' : 'legacy';
}

function isProcessableSyntheticTerminal(
  text: string,
  status: TaskStatusOutput,
): boolean {
  if (status.state !== 'completed' && status.state !== 'error') return false;

  const summary = extractTaskSummary(text);
  const isCompleted = summary
    ? BACKGROUND_COMPLETION_COMPLETED.test(summary)
    : status.state === 'completed';
  const isFailed = summary
    ? BACKGROUND_COMPLETION_FAILED.test(summary)
    : status.state === 'error';
  return (
    (!summary || isCompleted || isFailed) &&
    (!isCompleted || status.state === 'completed') &&
    (!isFailed || status.state === 'error')
  );
}

function observationOccurrenceID(
  part: MessagePart,
  status: TaskStatusOutput,
): { occurrenceID: string; reliable: boolean } {
  const explicitOccurrenceID = getExplicitOccurrenceID(part);
  if (explicitOccurrenceID) {
    return { occurrenceID: explicitOccurrenceID, reliable: true };
  }

  const messageID = getHostMessageID(part);
  if (messageID) {
    return {
      occurrenceID: hostMessageOccurrenceID(
        messageID,
        status.taskID,
        part.text ?? '',
      ),
      reliable: true,
    };
  }

  return {
    occurrenceID: `ambiguous:${djb2Hash(
      `unknown-message:${status.taskID}:${part.text ?? ''}`,
    )}`,
    reliable: false,
  };
}

function rememberSyntheticTerminalOccurrence(
  state: InjectionState,
  origin: SyntheticTerminalOccurrenceOrigin,
  provenanceKind: SyntheticTerminalProvenanceKind,
): void {
  const occurrences = state.syntheticTerminalOccurrences;
  const order = state.syntheticTerminalOccurrenceOrder;
  if (!occurrences || !order) return;

  const key = injectedCompletionKey(
    origin.taskID,
    origin.occurrenceID,
    provenanceKind,
  );
  const existing = occurrences.get(key);
  if (existing) {
    // The first observation owns the lifecycle provenance. A later event for
    // the same part must not refresh an old occurrence into a new generation.
    if (existing.phase === 'processed') return;
    if (existing.phase === 'observed') return;
    // An ambiguous first observation is a permanent fail-closed decision. A
    // late event can be an old part replayed after a same-ID relaunch, so it
    // must never upgrade the occurrence with the current generation.
    return;
  }

  occurrences.set(key, { ...origin });
  order.push(key);
}

function findSyntheticTerminalOccurrence(
  state: InjectionState,
  taskID: string,
  occurrenceID: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  explicitOccurrenceID: boolean,
  currentGeneration: number | undefined,
  currentTaskGeneration: number | undefined,
  deletionEpoch: number | undefined,
): SyntheticTerminalOccurrenceLookup | undefined {
  const occurrences = state.syntheticTerminalOccurrences;
  if (!occurrences) return undefined;

  const direct = occurrences.get(
    injectedCompletionKey(taskID, occurrenceID, provenanceKind),
  );
  if (explicitOccurrenceID) {
    return direct ? { kind: 'matched', origin: direct } : undefined;
  }
  if (direct && provenanceKind !== 'host-message') {
    return { kind: 'matched', origin: direct };
  }

  if (provenanceKind === 'host-message') {
    // Host message ids are weaker than part ids. Restrict them to the first
    // generation: unrelated tasks do not advance this task-local run proof.
    if (deletionEpoch !== undefined || currentTaskGeneration !== 1) {
      return direct ? { kind: 'matched', origin: direct } : undefined;
    }

    const candidates = [...occurrences.entries()]
      .filter(
        ([key, origin]) =>
          hasProvenanceKind(key, taskID, 'host-message') &&
          origin.taskID === taskID &&
          origin.generationAtObservation === currentGeneration,
      )
      .map(([, origin]) => origin);
    if (
      candidates.length === 1 &&
      candidates[0].occurrenceID === occurrenceID
    ) {
      return { kind: 'matched', origin: candidates[0] };
    }
    if (candidates.length > 1) {
      return {
        kind: 'ambiguous',
        reason: `multiple current-generation host message.part.updated origins (${candidates.length}) could not be uniquely matched`,
      };
    }

    return direct ? { kind: 'matched', origin: direct } : undefined;
  }

  // Older/runtime-derived parts may lack an id in the transform payload. Do
  // not guess ownership from an ambiguous event; the legacy path is allowed to
  // fail closed, but it may not manufacture a match from candidate count.
  const legacyCandidates = [...occurrences.entries()].filter(
    ([key, origin]) =>
      hasProvenanceKind(key, taskID, 'legacy') && origin.taskID === taskID,
  );
  if (legacyCandidates.length > 0) {
    return {
      kind: 'ambiguous',
      reason: 'legacy weak provenance did not match a canonical host identity',
    };
  }
  return undefined;
}

function rememberProcessedSyntheticTerminal(
  state: InjectionState,
  taskID: string,
  occurrenceID: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  origin: SyntheticTerminalOccurrenceOrigin | undefined,
  generation: number | undefined,
): void {
  if (origin) {
    origin.phase = 'processed';
    return;
  }

  rememberSyntheticTerminalOccurrence(
    state,
    {
      taskID,
      occurrenceID,
      generationAtObservation: generation,
      lifecycleEpochAtObservation: state.getLifecycleEpoch?.() ?? 0,
      phase: 'processed',
    },
    provenanceKind,
  );
}

function failClosedSyntheticTerminal(
  state: InjectionState,
  status: TaskStatusOutput,
  occurrenceID: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  existing: BackgroundJobRecord | undefined,
  reason: string,
): void {
  rememberSyntheticTerminalOccurrence(
    state,
    {
      taskID: status.taskID,
      occurrenceID,
      generationAtObservation: existing?.generation,
      lifecycleEpochAtObservation: state.getLifecycleEpoch?.() ?? 0,
      phase: 'ambiguous',
    },
    provenanceKind,
  );

  if (existing?.state === 'running') {
    markSyntheticTerminalUncertain(
      state,
      status.taskID,
      existing,
      `Synthetic terminal task output origin is ambiguous: ${reason}`,
    );
  }

  log('[task-session-manager] skipped ambiguous synthetic completion', {
    taskID: status.taskID,
    occurrenceID,
    generation: existing?.generation,
    lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
    reason,
  });
}

function markSyntheticTerminalUncertain(
  state: InjectionState,
  taskID: string,
  existing: BackgroundJobRecord,
  reason: string,
): void {
  state.backgroundJobBoard.markStatusUncertain(
    taskID,
    reason,
    existing.generation,
  );
}

/**
 * Record a terminal synthetic task part at the runtime event boundary. The
 * part can be transformed later, after deletion and a same-ID relaunch, so
 * payload fields alone are not sufficient to recover its original generation.
 */
export function observeSyntheticTerminalPart(
  state: InjectionState,
  value: unknown,
): void {
  if (!isRecord(value)) return;
  const part = value as MessagePart;
  if (part.type !== 'text' || part.synthetic !== true) return;
  if (typeof part.text !== 'string') return;

  const status = parseTaskStatusOutput(part.text);
  if (!status || !isProcessableSyntheticTerminal(part.text, status)) return;

  const { occurrenceID, reliable } = observationOccurrenceID(part, status);
  const provenanceKind = provenanceKindForPart(part);
  const existing = state.backgroundJobBoard.get(status.taskID);
  const lifecycleEpoch = state.getLifecycleEpoch?.() ?? 0;
  const deletionEpoch = state.getDeletionEpoch?.(status.taskID);
  const occurrenceKey = injectedCompletionKey(
    status.taskID,
    occurrenceID,
    provenanceKind,
  );
  const priorOccurrence =
    state.syntheticTerminalOccurrences?.get(occurrenceKey);
  const hasPreDeletionProvenance =
    deletionEpoch === undefined ||
    (priorOccurrence !== undefined &&
      priorOccurrence.lifecycleEpochAtObservation < deletionEpoch &&
      priorOccurrence.phase !== 'ambiguous');
  const hostMessageProvenance = provenanceKind === 'host-message';
  const phase: SyntheticTerminalOccurrencePhase =
    !reliable ||
    !existing ||
    (hostMessageProvenance
      ? deletionEpoch !== undefined || existing.taskGeneration !== 1
      : !hasPreDeletionProvenance)
      ? 'ambiguous'
      : 'observed';

  rememberSyntheticTerminalOccurrence(
    state,
    {
      taskID: status.taskID,
      occurrenceID,
      generationAtObservation: existing?.generation,
      lifecycleEpochAtObservation: lifecycleEpoch,
      phase,
    },
    provenanceKind,
  );
}

function hasRememberedInjectedCompletion(
  state: InjectionState,
  taskID: string,
  occurrenceId: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  currentGeneration: number | undefined,
): boolean {
  const fence = state.injectedCompletionFences?.get(
    injectedCompletionKey(taskID, occurrenceId, provenanceKind),
  );
  if (!fence) return false;

  const deletionEpoch = state.getDeletionEpoch?.(taskID);
  const staleGeneration =
    currentGeneration !== undefined && currentGeneration !== fence.generation;
  const staleLifecycle =
    deletionEpoch !== undefined && fence.lifecycleEpoch < deletionEpoch;
  if (staleGeneration || staleLifecycle) {
    log('[task-session-manager] skipped stale injected completion', {
      taskID,
      occurrenceId,
      recordedGeneration: fence.generation,
      currentGeneration,
      recordedLifecycleEpoch: fence.lifecycleEpoch,
      deletionEpoch,
    });
  }

  // A known occurrence is either a duplicate in the same lifecycle or stale
  // history from an older generation. Neither may update the current board.
  return true;
}

function rememberInjectedCompletionFence(
  state: InjectionState,
  occurrenceId: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  fence: InjectedCompletionFence,
): void {
  const fences = state.injectedCompletionFences;
  if (!fences) return;

  fences.set(
    injectedCompletionKey(fence.taskID, occurrenceId, provenanceKind),
    { ...fence },
  );
}

// ── Exported functions ─────────────────────────────────────────────────

/**
 * Normalize the `output` of every still-running `task` tool result to a
 * static, deterministic placeholder keyed only on the task ID.
 *
 * OpenCode core stores a fixed running placeholder in `state.output` when a
 * background task launches and materializes the terminal result separately as
 * a synthetic completion message. However, the runtime is free to stream live
 * child progress into a running task part's `state.output` (foreground
 * promotion, future core versions). Any such mid-history mutation invalidates
 * the provider prompt cache from that byte onward, re-writing the entire tail
 * every request while a background lane runs (write-never-read loop).
 *
 * This makes running task parts byte-stable at the plugin layer: it only ever
 * touches parts whose parsed state is `running`, so terminal
 * (completed/error/cancelled) results — which must reach the orchestrator
 * intact and mutate exactly once on completion — are never altered. It is a
 * pure normalization: re-running it on an already-stabilized part is a no-op.
 * Foreground (`wait:true`) tasks block and return a terminal state, so their
 * parts are never running here and keep their real output.
 */
export function stabilizeRunningTaskParts(messages: unknown[]): void {
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      const state = part.state;
      if (!isRecord(state)) continue;
      if (typeof state.output !== 'string') continue;

      // Only running task results are volatile. Terminal results (completed,
      // error, cancelled) are materialized exactly once and must stay intact.
      const header = parseTaskOutputHeader(state.output);
      const status = header.taskID && header.state ? header : undefined;
      const runningByStatus = status?.state === 'running';
      const runningByField =
        state.status === 'running' && (status === undefined || runningByStatus);
      if (!runningByStatus && !runningByField) continue;

      const taskID = status?.taskID;
      if (!taskID) continue;

      const placeholder = renderRunningTaskPlaceholder(taskID);
      if (state.output === placeholder) continue;
      state.output = placeholder;
    }
  }
}

export async function updateFromInjectedCompletion(
  state: InjectionState,
  part: MessagePart,
  message: MessageWithParts,
  messageIndex: number,
  partIndex: number,
): Promise<BackgroundJobRecord | undefined> {
  if (part.type !== 'text' || typeof part.text !== 'string') {
    return undefined;
  }

  if (part.synthetic !== true) return undefined;

  const header = parseTaskOutputHeader(part.text);
  if (!header.taskID || !header.state) {
    // Only flag text shaped like task-status output that failed to parse.
    // Native delegation prompts (e.g. OpenCode's "@agent" expansion) are
    // synthetic but never task-status shaped — skip silently.
    if (header.taskID || header.state) {
      const key = JSON.stringify([
        message.info.sessionID,
        part.id ?? [message.info.id ?? messageIndex, partIndex],
      ]);
      if (!loggedMissingTaskStatus.has(key)) {
        if (loggedMissingTaskStatus.size >= 1024)
          loggedMissingTaskStatus.delete(
            loggedMissingTaskStatus.values().next().value as string,
          );
        loggedMissingTaskStatus.add(key);
        log('[task-session-manager] synthetic part missing task status', {
          textPreview: part.text.slice(0, 120),
        });
      }
    }
    return undefined;
  }

  // A processed match is a no-op; ambiguous weak provenance must still fail closed.
  if (state.syntheticTerminalOccurrences?.size) {
    const explicitId = getExplicitOccurrenceID(part);
    const messageId = getCanonicalHostMessageID(part, message);
    const occurrenceId =
      explicitId ??
      (messageId &&
        hostMessageOccurrenceID(messageId, header.taskID, part.text));
    if (occurrenceId) {
      const existing = state.backgroundJobBoard.get(header.taskID);
      const lookup = findSyntheticTerminalOccurrence(
        state,
        header.taskID,
        occurrenceId,
        explicitId ? 'explicit' : 'host-message',
        !!explicitId,
        existing?.generation,
        existing?.taskGeneration,
        state.getDeletionEpoch?.(header.taskID),
      );
      if (lookup?.kind === 'matched' && lookup.origin.phase === 'processed')
        return undefined;
    }
  }

  const status = parseTaskStatusOutput(part.text);
  if (!status) return undefined;
  if (!isProcessableSyntheticTerminal(part.text, status)) {
    return undefined;
  }

  const summary = extractTaskSummary(part.text);
  const isCompleted = summary
    ? BACKGROUND_COMPLETION_COMPLETED.test(summary)
    : status.state === 'completed';
  const isFailed = summary
    ? BACKGROUND_COMPLETION_FAILED.test(summary)
    : status.state === 'error';
  if (summary && !isCompleted && !isFailed) return undefined;

  const occurrenceId = createOccurrenceId(part, message, partIndex);
  const provenanceKind = provenanceKindForPart(part, message);
  const hasExplicitOccurrenceID = provenanceKind === 'explicit';

  const existing = state.backgroundJobBoard.get(status.taskID);
  const deletionEpoch = state.getDeletionEpoch?.(status.taskID);
  const occurrenceLookup = findSyntheticTerminalOccurrence(
    state,
    status.taskID,
    occurrenceId,
    provenanceKind,
    hasExplicitOccurrenceID,
    existing?.generation,
    existing?.taskGeneration,
    deletionEpoch,
  );
  const origin =
    occurrenceLookup?.kind === 'matched' ? occurrenceLookup.origin : undefined;

  if (occurrenceLookup?.kind === 'ambiguous') {
    failClosedSyntheticTerminal(
      state,
      status,
      occurrenceId,
      provenanceKind,
      existing,
      occurrenceLookup.reason,
    );
    return undefined;
  }

  if (origin?.phase === 'processed') return undefined;

  if (origin?.phase === 'ambiguous') {
    failClosedSyntheticTerminal(
      state,
      status,
      occurrenceId,
      provenanceKind,
      existing,
      'message.part.updated origin was permanently ambiguous',
    );
    return undefined;
  }

  if (provenanceKind === 'host-message') {
    if (
      !origin ||
      !existing ||
      deletionEpoch !== undefined ||
      origin.phase !== 'observed' ||
      existing.taskGeneration !== 1 ||
      origin.generationAtObservation !== existing.generation
    ) {
      failClosedSyntheticTerminal(
        state,
        status,
        occurrenceId,
        provenanceKind,
        existing,
        'host messageID provenance did not identify exactly one current origin',
      );
      return undefined;
    }
  }

  if (origin?.phase === 'observed') {
    const generationChanged =
      origin.generationAtObservation !== undefined &&
      existing?.generation !== origin.generationAtObservation;
    const observationPredatesDeletion =
      deletionEpoch !== undefined &&
      origin.lifecycleEpochAtObservation < deletionEpoch;
    if (generationChanged || observationPredatesDeletion) {
      if (existing?.state === 'running') {
        markSyntheticTerminalUncertain(
          state,
          status.taskID,
          existing,
          'Synthetic terminal task output belongs to an older lifecycle.',
        );
      }
      log(
        '[task-session-manager] skipped stale observed synthetic completion',
        {
          taskID: status.taskID,
          occurrenceId,
          observedGeneration: origin.generationAtObservation,
          currentGeneration: existing?.generation,
          observationEpoch: origin.lifecycleEpochAtObservation,
          deletionEpoch,
        },
      );
      return undefined;
    }
  }

  // Fence-first: a remembered (possibly stale) completion occurrence must
  // skip CLEANLY before the deletion-epoch fail-closed branch below. A
  // known occurrence is either a duplicate in the same lifecycle or stale
  // history from an older generation — neither may update the current
  // board, and neither justifies poisoning the fresh generation with
  // markStatusUncertain when its occurrence bookkeeping is absent.
  if (
    hasRememberedInjectedCompletion(
      state,
      status.taskID,
      occurrenceId,
      provenanceKind,
      existing?.generation,
    )
  ) {
    return undefined;
  }

  if (deletionEpoch !== undefined && origin === undefined) {
    failClosedSyntheticTerminal(
      state,
      status,
      occurrenceId,
      provenanceKind,
      existing,
      'no message.part.updated origin was observed',
    );
    return undefined;
  }

  if (isFailed && isLateCancelledTaskError(existing, status.state)) {
    log('[task-session-manager] normalized late cancelled injected failure', {
      taskID: status.taskID,
      alias: existing?.alias,
      parsedState: status.state,
      boardState: existing?.state,
      terminalState: existing?.terminalState,
      result: status.result,
    });
    rememberProcessedInjectedCompletion(
      state,
      status.taskID,
      occurrenceId,
      provenanceKind,
      {
        taskID: status.taskID,
        generation: existing?.generation ?? 0,
        lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
      },
    );
    rememberProcessedSyntheticTerminal(
      state,
      status.taskID,
      occurrenceId,
      provenanceKind,
      origin,
      existing?.generation,
    );
    return existing;
  }

  if (isCompleted && status.state !== 'completed') return undefined;
  if (isFailed && status.state !== 'error') return undefined;

  const processedOccurrenceKey = injectedCompletionKey(
    status.taskID,
    occurrenceId,
    provenanceKind,
  );
  if (state.processedInjectedCompletions.has(processedOccurrenceKey)) {
    return undefined;
  }

  if (!existing) return undefined;
  // Reception deduplication is separate from terminal confirmation. A replay
  // without an observed execution owner can only request an inspection.
  rememberProcessedInjectedCompletion(
    state,
    status.taskID,
    occurrenceId,
    provenanceKind,
    {
      taskID: existing.taskID,
      generation: existing.generation,
      lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
    },
  );
  const result = await state.terminalGate.reconcile(
    existing,
    origin?.generationAtObservation === existing.generation
      ? {
          kind: 'output',
          status,
          origin: {
            kind: 'synthetic',
            occurrenceID: occurrenceId,
            run: existing,
            provenance: provenanceKind,
          },
        }
      : { kind: 'inspect' },
  );
  const updated = result.kind === 'stale' ? undefined : result.record;
  if (!updated) return undefined;

  log('[task-session-manager] processed injected background completion', {
    taskID: updated.taskID,
    alias: updated.alias,
    parentSessionID: updated.parentSessionID,
    state: updated.state,
    occurrenceId,
  });

  rememberProcessedSyntheticTerminal(
    state,
    updated.taskID,
    occurrenceId,
    provenanceKind,
    origin,
    updated.generation,
  );
  rememberProcessedInjectedCompletion(
    state,
    status.taskID,
    occurrenceId,
    provenanceKind,
    {
      taskID: updated.taskID,
      generation: updated.generation,
      lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
    },
  );
  return updated;
}

export function rememberProcessedInjectedCompletion(
  state: InjectionState,
  taskID: string,
  occurrenceId: string,
  provenanceKind: SyntheticTerminalProvenanceKind,
  fence?: InjectedCompletionFence,
): void {
  const signature = injectedCompletionKey(taskID, occurrenceId, provenanceKind);
  state.processedInjectedCompletions.add(signature);
  state.processedInjectedCompletionOrder.push(signature);

  if (fence) {
    rememberInjectedCompletionFence(state, occurrenceId, provenanceKind, fence);
  }
}

export function isMissingRememberedSessionError(output: string): boolean {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? '';
  return (
    firstLine.startsWith('[error]') &&
    firstLine.includes('session') &&
    (firstLine.includes('not found') || firstLine.includes('no session'))
  );
}

function reconcileExecutionBatch(
  state: InjectionState,
  parentSessionID: string,
  executions: Iterable<BackgroundJobExecution>,
): void {
  for (const execution of executions) {
    const current = state.backgroundJobBoard.get(execution.taskID);
    if (
      !current ||
      current.generation !== execution.generation ||
      current.terminalRevision !== execution.terminalRevision
    ) {
      log('[task-session-manager] skipped stale terminal execution', {
        parentSessionID,
        execution,
        currentGeneration: current?.generation,
      });
      continue;
    }
    const reconciled = state.backgroundJobBoard.markReconciled(
      execution.taskID,
      undefined,
      execution.generation,
      execution.terminalRevision,
    );
    // The parent has now consumed this terminal report. Remember the run
    // so a later reopen-to-running (child session busy again) can be
    // corrected with exactly one trailing notice.
    if (reconciled) {
      rememberReportedTerminalRun(state, parentSessionID, {
        taskID: execution.taskID,
        generation: execution.generation,
        terminalState: reconciled.terminalState ?? reconciled.state,
      });
    }
  }
}

// ── Native delivery observer (v2 boardless primary; v1 never reaches it) ─
//
// On OpenCode v2 hosts the host itself delivers each background completion
// exactly once as a synthetic session message in the parent's history:
// `<subagent sessionID="..." state="completed|error|cancelled">…</subagent>`
// (host `SessionInbox` steer/queue delivery; the native notifier never
// delivers `stopped`). Observing that delivery retires the tracked record
// directly, replacing the prompt-shape registration bookkeeping
// on the v2 path. On v1 the native delivery is untagged, so the plugin
// cannot attribute it; those runs retire through the plugin's own tagged
// push or the stale-terminal fallback instead.

type ObservedNativeDelivery = NativeDelivery & {
  /** Dedupe key: the delivery part's own message/part identity. */
  seenKey: string;
};

/**
 * Skew allowance for the current-publication check: the terminal event the
 * plugin observes and the host's delivery-message creation are concurrent
 * within one tick on the same clock, but either may land a few milliseconds
 * first. A delivery authored earlier than this before the current
 * publication's completedAt is unambiguously an older report.
 */
const NATIVE_DELIVERY_PUBLICATION_SKEW_MS = 2_000;

/**
 * LRU cap for one parent's consumed native-delivery keys. Far above any
 * normal session's live delivery count: the bound exists so a pathological
 * history (or a missed session-end prune) cannot grow the set without limit.
 * Eviction only re-opens the one-shot pairing window for the oldest keys,
 * which the reopen gate and the stale-terminal fallback still cover.
 */
const NATIVE_DELIVERY_SEEN_CAP = 1024;

/**
 * Byte-stable, persisted identity for one observed delivery part: the host
 * message id plus the part index, bound to the part text so an id reused
 * for different content cannot collide. Parts without a host message id
 * fall back to a content hash. Prompt shape never enters the key.
 */
function nativeDeliverySeenKey(
  message: MessageWithParts,
  partIndex: number,
  text: string,
): string {
  const messageID =
    typeof message.info.id === 'string' && message.info.id.trim() !== ''
      ? message.info.id
      : undefined;
  const textHash = sha256Hash(text);
  return messageID === undefined
    ? `anon:${textHash}`
    : `${messageID}:${partIndex}:${textHash}`;
}

/**
 * Reconcile tracked records against the native v2 deliveries already
 * present in the parent's message history. Pairing is ONE-SHOT: a delivery
 * key is remembered on first observation and can retire at most one
 * terminal publication — the record's CURRENT terminal run at that moment,
 * and only when the delivered state equals it. Deliveries observed earlier
 * (running, reconciled, mismatched, stopped) can never pair later (Greptile
 * P1-2). Untracked sessionIDs are idempotent no-ops. `stopped` records are
 * never retired here (native never delivers stops; they retire through the
 * recovery-wake + task_revive ack flow).
 */
function reconcileObservedNativeDeliveries(
  state: InjectionState,
  messages: unknown[],
): void {
  state.observedNativeDeliveries ??= new Map<string, Map<string, true>>();
  const seenByParent = state.observedNativeDeliveries;
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    const parentSessionID = message.info.sessionID;
    if (!parentSessionID || !state.shouldManageSession(parentSessionID)) {
      continue;
    }
    let seen = seenByParent.get(parentSessionID);
    if (!seen) {
      seen = new Map<string, true>();
      seenByParent.set(parentSessionID, seen);
    }
    message.parts.forEach((part, partIndex) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return;
      if (isTaggedPart(part, state.metadataKey)) return;
      const delivery = parseNativeDelivery(part);
      if (!delivery) return;
      const seenKey = nativeDeliverySeenKey(message, partIndex, part.text);
      if (seen.has(seenKey)) {
        // LRU touch: a delivery the parent's history still replays must not
        // age out ahead of keys that stopped appearing in history.
        rememberDeliveryKey(seen, seenKey);
        return;
      }

      const record = state.backgroundJobBoard.get(delivery.taskID);
      if (!record || record.parentSessionID !== parentSessionID) {
        // Unknown child or parent mismatch: leave the key unobserved (a
        // later transform may know the child), bounded by session end.
        return;
      }
      // One-shot pairing with a reopen gate (Greptile P1-2): a delivery's
      // own publication causally precedes the record's later reopens, so a
      // delivery observed while its record runs after a reopen can never
      // report the CURRENT run. Remember such keys on first sight; never
      // let them pair later. Deliveries of the current run are either
      // observed when the record is already terminal (paired below), or
      // race the terminal gate (still retryable — no reopen happened yet,
      // so lastLiveBusyAt is unset). The current publication otherwise
      // retires via its own delivery or retireStaleTerminalRecords.
      const deliveryTime = messageCreatedAt(message);
      // Trusted metadata proves who authored the delivery, not WHICH run it
      // reports. Without a host timestamp no causal fence can be checked.
      if (deliveryTime === undefined) return;
      if (!record.terminalUnreconciled) {
        if (
          record.state === 'running' &&
          record.lastLiveBusyAt !== undefined &&
          deliveryTime !== undefined &&
          (deliveryTime < record.lastLiveBusyAt ||
            deliveryTime < record.lastLaunchedAt)
        ) {
          // Authored at or before the reopen (or the current launch): this
          // is a previous publication's report, stranded in history.
          rememberDeliveryKey(seen, seenKey);
        }
        return;
      }
      // Remember the key on first terminal observation: from here the
      // record can only reopen (bumping terminalRevision via
      // markRunningFromLiveSession) — any later same-state match would be
      // a NEWER publication this delivery cannot report.
      rememberDeliveryKey(seen, seenKey);
      // Provably stale: authored before the record's last launch, so it
      // predates the current run and every future one (lastLaunchedAt only
      // advances). A record can reopen and change terminal state, so state
      // equality alone is never proof of currency.
      if (deliveryTime !== undefined && deliveryTime < record.lastLaunchedAt) {
        return;
      }
      // Post-reopen runs: a delivery authored before the reopen can never
      // report the reopened run's completion. The seen-set only accelerates
      // this — causality must hold independently of LRU eviction (PR #1608
      // review). lastLiveBusyAt is set only by markRunningFromLiveSession.
      if (
        record.lastLiveBusyAt !== undefined &&
        deliveryTime !== undefined &&
        deliveryTime < record.lastLiveBusyAt
      ) {
        return;
      }
      // Predates the CURRENT publication: markRunningFromLiveSession clears
      // completedAt on reopen, so completedAt always marks the current
      // terminal publication. Both clocks are host-side, but the terminal
      // event and the message creation are concurrent within one tick —
      // allow a small skew so a same-publication delivery is never burned.
      if (
        record.completedAt !== undefined &&
        deliveryTime !== undefined &&
        deliveryTime < record.completedAt - NATIVE_DELIVERY_PUBLICATION_SKEW_MS
      ) {
        return;
      }
      // A delivery retires only the terminal run it reports: the record's
      // terminal state must equal the delivered state.
      const terminalState = record.terminalState ?? record.state;
      if (terminalState !== delivery.state) return;
      if (
        !NATIVE_DELIVERY_STATES.has(
          record.state as ObservedNativeDelivery['state'],
        )
      ) {
        // stopped: retires only through the recovery-wake + task_revive
        // ack flow; the remembered key never pairs.
        return;
      }
      reconcileExecutionBatch(state, parentSessionID, [
        {
          taskID: record.taskID,
          generation: record.generation,
          terminalRevision: record.terminalRevision,
        },
      ]);
    });
  }
}

/**
 * Remember (or refresh) one consumed native-delivery key. Map insertion
 * order is the recency order: delete+set moves the key to the newest
 * position, so a re-observed delivery never ages out ahead of keys that
 * stopped appearing in history. The oldest keys are evicted past
 * `NATIVE_DELIVERY_SEEN_CAP`.
 */
function rememberDeliveryKey(seen: Map<string, true>, seenKey: string): void {
  seen.delete(seenKey);
  seen.set(seenKey, true);
  while (seen.size > NATIVE_DELIVERY_SEEN_CAP) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/**
 * Council risk #1 mitigation: a terminal record whose terminal time is older
 * than the newest parent assistant turn retires unconditionally at the next
 * transform — the parent demonstrably moved past the terminal report, so a
 * missed observation (compaction/restart/steer race) cannot wedge the
 * hasTerminalUnreconciled consumers forever. Covers completed, error, AND
 * cancelled (cancelled has no native delivery and no push delta, so this
 * fallback is its only retirement channel on v1). `stopped` records are
 * excluded (recovery-wake ownership). Runs without comparable timestamps
 * fail closed.
 */
function retireStaleTerminalRecords(
  state: InjectionState,
  messages: unknown[],
): void {
  const newestAssistantTurnByParent = new Map<string, number>();
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    if (message.info.role !== 'assistant') continue;
    const parentSessionID = message.info.sessionID;
    if (!parentSessionID || !state.shouldManageSession(parentSessionID)) {
      continue;
    }
    const createdAt = messageCreatedAt(message);
    if (createdAt === undefined) continue;
    const newest = newestAssistantTurnByParent.get(parentSessionID);
    if (newest === undefined || createdAt > newest) {
      newestAssistantTurnByParent.set(parentSessionID, createdAt);
    }
  }
  if (newestAssistantTurnByParent.size === 0) return;
  for (const [
    parentSessionID,
    newestAssistantTurn,
  ] of newestAssistantTurnByParent) {
    for (const record of state.backgroundJobBoard.list(parentSessionID)) {
      if (!record.terminalUnreconciled) continue;
      if (
        record.state !== 'completed' &&
        record.state !== 'error' &&
        record.state !== 'cancelled'
      ) {
        continue;
      }
      if (record.completedAt === undefined) continue;
      if (record.completedAt >= newestAssistantTurn) continue;
      // An undelivered queued push IS this publication's delivery: acking
      // the run here would fence the queued answer out forever. Its own
      // observed push (or a later fallback pass after delivery) retires it.
      if (
        state.hasUndeliveredTerminalPush?.(
          parentSessionID,
          record.taskID,
          record.generation,
        ) === true
      ) {
        continue;
      }
      reconcileExecutionBatch(state, parentSessionID, [
        {
          taskID: record.taskID,
          generation: record.generation,
          terminalRevision: record.terminalRevision,
        },
      ]);
    }
  }
}

/** Metadata fence entry of one delivered `<completed-job>` push part. */
type ObservedCompletedJobDelta = {
  taskID: string;
  generation: number;
  terminalRevision: number;
  state: 'completed' | 'error';
};

/** Validate the host-side fences carried by a push part. Anything malformed
 * is ignored: retirement must never fire on a partial record. */
function parseObservedCompletedJobFences(
  value: unknown,
): ObservedCompletedJobDelta[] {
  if (!Array.isArray(value)) return [];
  const fences: ObservedCompletedJobDelta[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { taskID, generation, terminalRevision, state } = entry;
    if (typeof taskID !== 'string' || taskID === '') continue;
    if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
      continue;
    }
    if (
      !Number.isSafeInteger(terminalRevision) ||
      (terminalRevision as number) < 0
    ) {
      continue;
    }
    if (state !== 'completed' && state !== 'error') continue;
    fences.push({
      taskID,
      generation: generation as number,
      terminalRevision: terminalRevision as number,
      state,
    });
  }
  return fences;
}

/** Text fallback when a host drops part metadata: the push body itself names
 * the task and terminal state. Only wake parts (internal-initiator tagged)
 * are considered, so model-authored text can never retire a record. */
function parseCompletedJobDeltaText(
  text: string,
): Array<{ taskID: string; state: 'completed' | 'error' }> {
  const blocks: Array<{ taskID: string; state: 'completed' | 'error' }> = [];
  for (const match of text.matchAll(
    /<completed-job>\n([\s\S]*?)\n<\/completed-job>/g,
  )) {
    const body = match[1] ?? '';
    const taskID = /^task: (.+)$/m.exec(body)?.[1]?.trim();
    const state = /^state: (completed|error)$/m.exec(body)?.[1];
    if (taskID && (state === 'completed' || state === 'error')) {
      blocks.push({ taskID, state });
    }
  }
  return blocks;
}

/** The plugin's own revived-run terminal notification
 * (`<task id="..." state="completed">`). It is a delivery the parent
 * observes in its history, so it retires that run like any other observed
 * delivery. */
function parseRevivedTerminalNotification(
  text: string,
): Array<{ taskID: string; state: 'completed' | 'error' }> {
  const blocks: Array<{ taskID: string; state: 'completed' | 'error' }> = [];
  for (const match of text.matchAll(
    /<task id="([^"]+)" state="(completed|error)">/g,
  )) {
    const taskID = match[1]?.trim();
    const state = match[2];
    if (taskID && (state === 'completed' || state === 'error')) {
      blocks.push({ taskID, state: state as 'completed' | 'error' });
    }
  }
  return blocks;
}

/**
 * Retirement-by-observed-delta (issue #1647). A later terminal publication
 * the plugin delivered as a `<completed-job>` push retires ONLY when that
 * push part is present in the parent's history and the record still holds the
 * exact run the part reported (generation + terminal revision). A reopened or
 * re-published record advances one of those, so an older part can never
 * consume it.
 */
function reconcileObservedTerminalDeltas(
  state: InjectionState,
  messages: unknown[],
): void {
  state.observedNativeDeliveries ??= new Map<string, Map<string, true>>();
  const seenByParent = state.observedNativeDeliveries;
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    const parentSessionID = message.info.sessionID;
    if (!parentSessionID || !state.shouldManageSession(parentSessionID)) {
      continue;
    }
    let seen = seenByParent.get(parentSessionID);
    if (!seen) {
      seen = new Map<string, true>();
      seenByParent.set(parentSessionID, seen);
    }
    const createdAt = messageCreatedAt(message);
    message.parts.forEach((part, partIndex) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return;
      const metadata = isRecord(part.metadata) ? part.metadata : undefined;
      const hasMetadataFence =
        metadata !== undefined &&
        Object.hasOwn(metadata, TERMINAL_DELTA_METADATA_KEY);
      if (hasMetadataFence) {
        const seenKey = nativeDeliverySeenKey(message, partIndex, part.text);
        if (seen.has(seenKey)) {
          rememberDeliveryKey(seen, seenKey);
          return;
        }
        // A present fence is authoritative even when malformed or stale:
        // never let its body fall through to the weaker text pairing.
        rememberDeliveryKey(seen, seenKey);
        for (const fence of parseObservedCompletedJobFences(
          metadata[TERMINAL_DELTA_METADATA_KEY],
        )) {
          const record = state.backgroundJobBoard.get(fence.taskID);
          if (!record || record.parentSessionID !== parentSessionID) continue;
          if (!record.terminalUnreconciled) continue;
          if (record.generation !== fence.generation) continue;
          if (record.terminalRevision !== fence.terminalRevision) continue;
          const terminalState = record.terminalState ?? record.state;
          if (terminalState !== fence.state) continue;
          reconcileExecutionBatch(state, parentSessionID, [
            {
              taskID: record.taskID,
              generation: fence.generation,
              terminalRevision: fence.terminalRevision,
            },
          ]);
        }
        return;
      }
      if (!isInternalInitiatorPart(part)) return;
      const observedDeliveries = [
        ...parseCompletedJobDeltaText(part.text),
        ...parseRevivedTerminalNotification(part.text),
      ];
      for (const block of observedDeliveries) {
        const record = state.backgroundJobBoard.get(block.taskID);
        if (!record || record.parentSessionID !== parentSessionID) continue;
        if (createdAt === undefined) continue;
        const seenKey = nativeDeliverySeenKey(message, partIndex, part.text);
        if (seen.has(seenKey)) {
          rememberDeliveryKey(seen, seenKey);
          continue;
        }
        if (!record.terminalUnreconciled) {
          if (
            record.state === 'running' &&
            ((record.lastLiveBusyAt !== undefined &&
              createdAt < record.lastLiveBusyAt) ||
              createdAt < record.lastLaunchedAt)
          ) {
            // This notice predates the current run; consume it while the
            // record is running so it cannot pair after a quick completion.
            rememberDeliveryKey(seen, seenKey);
          }
          continue;
        }
        if (record.completedAt === undefined) continue;
        // The first terminal observation consumes this notice, whether it
        // matches or not. A later reopen cannot make an old notice current.
        rememberDeliveryKey(seen, seenKey);
        if (createdAt < record.lastLaunchedAt) continue;
        if (
          record.lastLiveBusyAt !== undefined &&
          createdAt < record.lastLiveBusyAt
        ) {
          continue;
        }
        // Timestamp tolerance covers publication/transport skew only; the
        // launch and live-busy fences above identify a later reopened run.
        if (
          createdAt <
          record.completedAt - NATIVE_DELIVERY_PUBLICATION_SKEW_MS
        ) {
          continue;
        }
        const terminalState = record.terminalState ?? record.state;
        if (terminalState !== block.state) continue;
        reconcileExecutionBatch(state, parentSessionID, [
          {
            taskID: record.taskID,
            generation: record.generation,
            terminalRevision: record.terminalRevision,
          },
        ]);
      }
    });
  }
}

/**
 * Retire one terminal run the parent demonstrably observed: the host's native
 * completion part for it is present in the prompt being sent. Generation and
 * terminal revision are fenced by `reconcileExecutionBatch`, so a stale part
 * can never consume a re-published run.
 */
export function reconcileObservedTerminalRun(
  state: InjectionState,
  parentSessionID: string,
  run: { taskID: string; generation: number; terminalRevision: number },
): void {
  reconcileExecutionBatch(state, parentSessionID, [run]);
}

export async function injectBackgroundJobBoard(
  state: InjectionState,
  _input: Record<string, never>,
  output: { messages?: unknown },
): Promise<void> {
  const messages = Array.isArray(output.messages) ? output.messages : [];

  // The machine board is never rendered (issue #1647): this transform only
  // observes delivery facts already present in the parent history.
  //   1. Host-native `<subagent>` deliveries retire their record.
  //   2. Our own tagged `<completed-job>` push parts retire the exact
  //      publication they reported (generation + revision fenced).
  //   3. The stale-terminal fallback bounds a missed observation.
  //   4. Reopen corrections are staleness notices on the volatile tail.
  reconcileObservedNativeDeliveries(state, messages);
  reconcileObservedTerminalDeltas(state, messages);
  retireStaleTerminalRecords(state, messages);
  deliverReopenCorrectionsForTurn(state, messages);
}

/**
 * Boardless tail: reopen corrections are staleness notices, not board
 * status. A managed parent's latest real user turn anchors the volatile
 * trailing notice, and it is delivered on internal-initiator turns too (a
 * publication wake makes the parent run on an internal trigger, and the
 * correction is exactly what that turn needs).
 */
function deliverReopenCorrectionsForTurn(
  state: InjectionState,
  messages: unknown[],
): void {
  const trigger = findTriggeringUserMessage(messages, state.metadataKey);
  const sessionID = trigger?.info.sessionID;
  if (!trigger || !sessionID || !state.shouldManageSession(sessionID)) {
    return;
  }
  deliverReopenCorrections(state, sessionID, messages, trigger.info);
}

/**
 * The most recent real (non-board) user message that carries a text part —
 * used only to validate injection eligibility and derive session/text context.
 * Tool-result-only user turns (no text part) are skipped so a long tool loop
 * still resolves the triggering managed turn. Board placement targets the
 * tail (see injectBackgroundJobBoard).
 */
function findTriggeringUserMessage(
  messages: unknown[],
  metadataKey: string,
): MessageWithParts | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isMessageWithParts(message)) continue;
    if (
      message.parts.length > 0 &&
      message.parts.every((part) => isTaggedPart(part, metadataKey))
    ) {
      continue;
    }
    if (!isUserMessageWithParts(message)) continue;
    const hasText = message.parts.some(
      (part) => part.type === 'text' && typeof part.text === 'string',
    );
    if (!hasText) continue;
    return message;
  }
  return undefined;
}
