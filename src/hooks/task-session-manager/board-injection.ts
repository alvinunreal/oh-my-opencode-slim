/**
 * Board injection subsystem for task session manager.
 *
 * Handles injecting Background Job Board state into the message stream
 * and processing synthetic injected completions.
 *
 * All injection logic must go through the cache-safe helpers in
 * ../cache-safe-injection.ts to ensure prompt cache safety.
 */
import { createHash } from 'node:crypto';
import type {
  BackgroundJobExecution,
  BackgroundJobInjectedCompletionFence,
  BackgroundJobLifecycleLedger,
  BackgroundJobRecord,
  BackgroundJobStore,
  BackgroundJobSyntheticTerminalOccurrence,
  BackgroundJobSyntheticTerminalOccurrencePhase,
  ContextFile,
  TaskStatusOutput,
} from '../../utils';
import {
  isInternalInitiatorPart,
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
  parseTaskStatusOutput,
  renderRunningTaskPlaceholder,
  renderTaskTerminalFromBoard,
} from '../../utils';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  appendTaggedSyntheticPart,
  appendTrailingVolatileMessage,
  createTaggedSyntheticPart,
  hasTaggedPart,
  isTaggedPart,
  isVolatileTaggedMessage,
  stripTaggedContent,
} from '../cache-safe-injection';
import type { MessagePart, MessageWithParts } from '../types';
import { isMessageWithParts, isUserMessageWithParts } from '../types';
import {
  extractTaskSummary,
  formatCancelledTaskStatusOutput,
  isLateCancelledTaskError,
  updateBackgroundJobFromOutput,
} from './status-utils';

// ── Constants ──────────────────────────────────────────────────────────

export const BACKGROUND_JOB_BOARD_METADATA_KEY =
  'oh-my-opencode-slim.backgroundJobBoard';

const BACKGROUND_COMPLETION_COMPLETED = /^Background task completed: /;
const BACKGROUND_COMPLETION_FAILED = /^Background task failed: /;

type RetainedBoardSnapshot = {
  anchorKey: string;
  id: string;
  text: string;
  terminalUnreconciledTaskIDs: BackgroundJobExecution[];
};

export type RetainedBoardSnapshotState = {
  snapshots: RetainedBoardSnapshot[];
  nextSnapshotSequence: number;
  realMessageCount: number;
  firstRealMessageAnchorKey?: string;
};

/**
 * A board the `latest` strategy has already placed (and therefore already sent
 * to the provider) on a specific anchor message. Replayed byte-identically on
 * every later request once that anchor is no longer the tail, so a board that
 * was sent on a message the provider has cached never disappears.
 *
 * Only ONE placement is ever retained: a board that rode as a trailing PART on
 * a USER anchor (`anchorRole: 'user'`). That is the only shape that can be
 * reproduced later without inserting a message mid-array (A1) or grafting board
 * text onto a non-user message (A3). `anchorRole` stays a plain string so
 * legacy in-memory entries recorded by an earlier build (notably `'assistant'`,
 * which was replayed by splicing a synthetic message directly after the anchor
 * and could orphan a tool call from its result) are recognized and dropped
 * instead of replayed.
 */
type RetainedTailBoard = {
  anchorId: string;
  anchorRole: string;
  text: string;
};

type BoardAnchor = {
  message: MessageWithParts;
  id: string;
};

// ── State shape ────────────────────────────────────────────────────────

export type InjectedTerminalJobs = {
  executions: Map<string, BackgroundJobExecution>;
  /** Prompt shape when these executions were last surfaced to the model. */
  promptShapeKey: string;
};

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

export interface InjectionState {
  backgroundJobBoard: BackgroundJobStore;
  lifecycleLedger: BackgroundJobLifecycleLedger;
  maxRetainedSnapshots: number;
  strategy: 'latest' | 'checkpoint-compatible';
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
  terminalJobsInjectedByParent: Map<string, InjectedTerminalJobs>;
  pendingInjectedTerminalJobsByParent: Map<
    string,
    Map<string, BackgroundJobExecution>
  >;
  metadataKey: string;
  shouldManageSession: (sessionID: string) => boolean;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
  retainedBoardSnapshots: Map<string, RetainedBoardSnapshotState>;
  /**
   * Per-session log of boards the `latest` strategy has placed on real anchor
   * messages, keyed by anchor message id. Once an anchor is no longer the tail
   * its board is replayed byte-identically every later request, so a board sent
   * on a now-mid-history message is never stripped (which would rewrite already
   * cached bytes and bust the provider prompt-cache prefix from that message
   * onward - the field bust in dumps 000086->000087).
   */
  retainedTailBoards: Map<string, Map<string, RetainedTailBoard>>;
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

/**
 * True when board text may ride on this message as a trailing PART.
 *
 * Board text may ONLY ever be appended to a `user` message. This is the single
 * hard requirement behind the `AI_InvalidPromptError` this guard exists to
 * prevent, and it is a property of the host's message conversion:
 *
 * - the USER branch of `MessageV2.toModelMessagesEffect` copies text parts as
 *   `{ type: 'text', text }` and DISCARDS `part.metadata`;
 * - the ASSISTANT branch copies it as
 *   `{ type: 'text', text, providerMetadata: part.metadata }`, which
 *   `convertToModelMessages` then forwards as `providerOptions`.
 *
 * `providerOptions` is validated as `Record<string, Record<string, JSONValue>>`.
 * A board part's metadata is `{ '<metadataKey>': true }` — a boolean, not a
 * nested record — so any board text landing on an assistant-role message fails
 * `ModelMessage[]` validation and aborts the request before it is sent.
 *
 * Tool parts do not disqualify a user message: the user branch of the converter
 * only emits text/file/compaction/subtask parts, so a user message's tool parts
 * never become tool-call or tool-result content and cannot be separated from a
 * pairing by appended text. Keeping such anchors eligible is what preserves the
 * #889 tail-breakpoint placement (A4).
 */
function canCarryBoardPart(message: MessageWithParts): boolean {
  return message.info.role === 'user';
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

  if (typeof message.info.id === 'string') {
    return `${message.info.id}:${partIndex}`;
  }

  const sessionID = message.info.sessionID ?? 'unknown';
  const content = typeof part.text === 'string' ? part.text : '';

  const status = parseTaskStatusOutput(content);
  if (status) {
    const stableKey = `${sessionID}:${status.taskID}:${status.state}:${status.result ?? ''}`;
    const hash = djb2Hash(stableKey);
    return `anon:${hash}`;
  }

  const hash = djb2Hash(`${sessionID}:${content}`);
  return `anon:${hash}`;
}

function injectedCompletionKey(taskID: string, occurrenceId: string): string {
  return `${taskID}\u001f${occurrenceId}`;
}

function getExplicitOccurrenceID(part: MessagePart): string | undefined {
  for (const key of ['occurrenceID', 'occurrenceId', 'id']) {
    const value = part[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
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

  const messageID =
    typeof part.messageID === 'string' ? part.messageID : 'unknown-message';
  return {
    occurrenceID: `ambiguous:${djb2Hash(
      `${messageID}:${status.taskID}:${part.text ?? ''}`,
    )}`,
    reliable: false,
  };
}

function rememberSyntheticTerminalOccurrence(
  state: InjectionState,
  origin: SyntheticTerminalOccurrenceOrigin,
): void {
  const occurrences = state.syntheticTerminalOccurrences;
  const order = state.syntheticTerminalOccurrenceOrder;
  if (!occurrences || !order) return;

  const key = injectedCompletionKey(origin.taskID, origin.occurrenceID);
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
): SyntheticTerminalOccurrenceLookup | undefined {
  const occurrences = state.syntheticTerminalOccurrences;
  if (!occurrences) return undefined;

  const direct = occurrences.get(injectedCompletionKey(taskID, occurrenceID));
  if (direct) return { kind: 'matched', origin: direct };

  // Older/runtime-derived parts may lack an id in the transform payload even
  // though the event hook saw the same terminal text. Only use an ambiguous
  // fallback when there is exactly one candidate for this task. Multiple
  // candidates cannot establish ownership and must remain fail-closed.
  const candidates = [...occurrences.values()].filter(
    (origin) =>
      origin.taskID === taskID && origin.occurrenceID.startsWith('ambiguous:'),
  );
  if (candidates.length === 1) {
    return { kind: 'matched', origin: candidates[0] };
  }
  if (candidates.length > 1) {
    return {
      kind: 'ambiguous',
      reason: `multiple ambiguous message.part.updated origins (${candidates.length}) could not be uniquely matched`,
    };
  }
  return undefined;
}

function rememberProcessedSyntheticTerminal(
  state: InjectionState,
  taskID: string,
  occurrenceID: string,
  origin: SyntheticTerminalOccurrenceOrigin | undefined,
  generation: number | undefined,
): void {
  if (origin) {
    origin.phase = 'processed';
    return;
  }

  rememberSyntheticTerminalOccurrence(state, {
    taskID,
    occurrenceID,
    generationAtObservation: generation,
    lifecycleEpochAtObservation: state.getLifecycleEpoch?.() ?? 0,
    phase: 'processed',
  });
}

function failClosedSyntheticTerminal(
  state: InjectionState,
  status: TaskStatusOutput,
  occurrenceID: string,
  existing: BackgroundJobRecord | undefined,
  reason: string,
): void {
  rememberSyntheticTerminalOccurrence(state, {
    taskID: status.taskID,
    occurrenceID,
    generationAtObservation: existing?.generation,
    lifecycleEpochAtObservation: state.getLifecycleEpoch?.() ?? 0,
    phase: 'ambiguous',
  });

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
  const existing = state.backgroundJobBoard.get(status.taskID);
  const lifecycleEpoch = state.getLifecycleEpoch?.() ?? 0;
  const deletionEpoch = state.getDeletionEpoch?.(status.taskID);
  const occurrenceKey = injectedCompletionKey(status.taskID, occurrenceID);
  const priorOccurrence =
    state.syntheticTerminalOccurrences?.get(occurrenceKey);
  const hasPreDeletionProvenance =
    deletionEpoch === undefined ||
    (priorOccurrence !== undefined &&
      priorOccurrence.lifecycleEpochAtObservation < deletionEpoch &&
      priorOccurrence.phase !== 'ambiguous');
  const phase: SyntheticTerminalOccurrencePhase =
    !reliable || !existing || !hasPreDeletionProvenance
      ? 'ambiguous'
      : 'observed';

  rememberSyntheticTerminalOccurrence(state, {
    taskID: status.taskID,
    occurrenceID,
    generationAtObservation: existing?.generation,
    lifecycleEpochAtObservation: lifecycleEpoch,
    phase,
  });
}

function hasRememberedInjectedCompletion(
  state: InjectionState,
  taskID: string,
  occurrenceId: string,
  currentGeneration: number | undefined,
): boolean {
  const fence = state.injectedCompletionFences?.get(
    injectedCompletionKey(taskID, occurrenceId),
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
  fence: InjectedCompletionFence,
): void {
  const fences = state.injectedCompletionFences;
  if (!fences) return;

  fences.set(injectedCompletionKey(fence.taskID, occurrenceId), {
    ...fence,
  });
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
      const status = parseTaskStatusOutput(state.output);
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

/**
 * Reconcile false-cancelled foreground task tool parts.
 *
 * When a foreground task's child session hits a rate-limit and the
 * ForegroundFallbackManager aborts the session to swap models, opencode's
 * `runState.cancel` poisons the BackgroundJob the task tool is awaiting →
 * the tool returns `Effect.fail("Task cancelled")` → the assistant message's
 * tool part is written as `status:"error"` with `"Task cancelled"` in the
 * error field. The fallback model then completes on an orphan runLoop with
 * no awaiter; the board later records the real outcome (completed/error).
 *
 * This rewrites such false-cancelled error parts to reflect the board's
 * authoritative terminal state, so the orchestrator's history shows the
 * true result instead of a spurious cancellation (#595).
 *
 * Gated: only acts when the board holds a non-cancelled terminal state
 * (completed/reconciled/error) for the child session. True user cancels
 * leave the board in `cancelled`, so they are preserved unchanged. Idempotent:
 * after rewrite the part is no longer an error-with-cancelled, so subsequent
 * transforms skip it. This is the single intentional exception to
 * `stabilizeRunningTaskParts`' "terminal parts are immutable" rule —
 * cancelled-by-fallback is not a genuine terminal outcome, it is a transient
 * artifact of the abort+reprompt lifecycle split.
 */
export function reconcileFallbackFalseCancel(
  state: InjectionState,
  messages: unknown[],
): void {
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      const partState = part.state;
      if (!isRecord(partState)) continue;
      if (partState.status !== 'error') continue;
      const errorMsg = partState.error;
      if (typeof errorMsg !== 'string' || !/cancelled/i.test(errorMsg)) {
        continue;
      }
      const metadata = partState.metadata;
      if (!isRecord(metadata)) continue;
      const childSessionId = metadata.sessionId;
      if (typeof childSessionId !== 'string') continue;

      const job = state.backgroundJobBoard.get(childSessionId);
      if (!job) continue;
      // Only rewrite when the board has a non-cancelled terminal truth.
      // `reconciled` retains a `terminalState` of completed/error.
      const boardState = job.state;
      const terminal =
        job.terminalState ??
        (boardState === 'completed' || boardState === 'error'
          ? boardState
          : undefined);
      if (terminal !== 'completed' && terminal !== 'error') continue;

      const rendered = renderTaskTerminalFromBoard({
        taskID: childSessionId,
        state: terminal,
        description: job.description,
        resultSummary: job.resultSummary,
      });
      partState.status = terminal;
      partState.output = rendered;
      delete partState.error;
      log('[task-session-manager] reconciled false-cancelled task part', {
        taskID: childSessionId,
        alias: job.alias,
        parentSessionID: job.parentSessionID,
        boardState,
        terminalState: job.terminalState,
      });
    }
  }
}

export function updateFromInjectedCompletion(
  state: InjectionState,
  part: MessagePart,
  message: MessageWithParts,
  _messageIndex: number,
  partIndex: number,
): BackgroundJobRecord | undefined {
  if (part.type !== 'text' || typeof part.text !== 'string') {
    return undefined;
  }

  if (part.synthetic !== true) return undefined;

  const status = parseTaskStatusOutput(part.text);
  if (!status) {
    // Only flag text shaped like task-status output that failed to parse.
    // Native delegation prompts (e.g. OpenCode's "@agent" expansion) are
    // synthetic but never task-status shaped — skip silently.
    if (
      parseTaskIdFromTaskOutput(part.text) ||
      parseTaskStateFromOutput(part.text)
    ) {
      log('[task-session-manager] synthetic part missing task status', {
        textPreview: part.text.slice(0, 120),
      });
    }
    return undefined;
  }
  if (status.state !== 'completed' && status.state !== 'error') {
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

  const existing = state.backgroundJobBoard.get(status.taskID);
  const occurrenceLookup = findSyntheticTerminalOccurrence(
    state,
    status.taskID,
    occurrenceId,
  );
  const origin =
    occurrenceLookup?.kind === 'matched' ? occurrenceLookup.origin : undefined;
  const deletionEpoch = state.getDeletionEpoch?.(status.taskID);

  if (occurrenceLookup?.kind === 'ambiguous') {
    failClosedSyntheticTerminal(
      state,
      status,
      occurrenceId,
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
      existing,
      'message.part.updated origin was permanently ambiguous',
    );
    return undefined;
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

  if (deletionEpoch !== undefined && origin === undefined) {
    failClosedSyntheticTerminal(
      state,
      status,
      occurrenceId,
      existing,
      'no message.part.updated origin was observed',
    );
    return undefined;
  }

  if (
    hasRememberedInjectedCompletion(
      state,
      status.taskID,
      occurrenceId,
      existing?.generation,
    )
  ) {
    return undefined;
  }

  if (isFailed && isLateCancelledTaskError(existing, status.state)) {
    part.text = formatCancelledTaskStatusOutput(
      status.taskID,
      state.backgroundJobBoard.getResultSummary(status.taskID),
    );
    log('[task-session-manager] normalized late cancelled injected failure', {
      taskID: status.taskID,
      alias: existing?.alias,
      parsedState: status.state,
      boardState: existing?.state,
      terminalState: existing?.terminalState,
      result: status.result,
    });
    rememberProcessedInjectedCompletion(state, status.taskID, occurrenceId, {
      taskID: status.taskID,
      generation: existing?.generation ?? 0,
      lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
    });
    rememberProcessedSyntheticTerminal(
      state,
      status.taskID,
      occurrenceId,
      origin,
      existing?.generation,
    );
    if (existing?.terminalUnreconciled && existing?.parentSessionID) {
      rememberPendingInjectedTerminalJob(state, existing.parentSessionID, {
        taskID: existing.taskID,
        generation: existing.generation,
      });
    }
    return existing;
  }

  if (isCompleted && status.state !== 'completed') return undefined;
  if (isFailed && status.state !== 'error') return undefined;

  const processedOccurrenceKey = injectedCompletionKey(
    status.taskID,
    occurrenceId,
  );
  if (state.processedInjectedCompletions.has(processedOccurrenceKey)) {
    return undefined;
  }

  const updated = updateBackgroundJobFromOutput(
    part.text,
    state.backgroundJobBoard,
    state.taskContextTracker,
  );
  if (!updated) return undefined;

  if (updated.terminalUnreconciled && updated.parentSessionID) {
    rememberPendingInjectedTerminalJob(state, updated.parentSessionID, {
      taskID: updated.taskID,
      generation: updated.generation,
    });
  }

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
    origin,
    updated.generation,
  );
  rememberProcessedInjectedCompletion(state, status.taskID, occurrenceId, {
    taskID: updated.taskID,
    generation: updated.generation,
    lifecycleEpoch: state.getLifecycleEpoch?.() ?? 0,
  });
  return updated;
}

export function rememberProcessedInjectedCompletion(
  state: InjectionState,
  taskID: string,
  occurrenceId: string,
  fence?: InjectedCompletionFence,
): void {
  const signature = injectedCompletionKey(taskID, occurrenceId);
  state.processedInjectedCompletions.add(signature);
  state.processedInjectedCompletionOrder.push(signature);

  if (fence) {
    rememberInjectedCompletionFence(state, occurrenceId, fence);
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

function executionKey(execution: BackgroundJobExecution): string {
  return `${execution.taskID}\u001f${execution.generation}`;
}

function sameExecutionIdentity(
  left: readonly BackgroundJobExecution[],
  right: readonly BackgroundJobExecution[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = new Set(left.map(executionKey));
  return right.every((execution) => leftKeys.has(executionKey(execution)));
}

function rememberPendingInjectedTerminalJob(
  state: InjectionState,
  parentSessionID: string,
  execution: BackgroundJobExecution,
): void {
  const pending =
    state.pendingInjectedTerminalJobsByParent.get(parentSessionID) ??
    new Map<string, BackgroundJobExecution>();
  pending.set(executionKey(execution), { ...execution });
  state.pendingInjectedTerminalJobsByParent.set(parentSessionID, pending);
}

function reconcileExecutionBatch(
  state: InjectionState,
  parentSessionID: string,
  executions: Iterable<BackgroundJobExecution>,
): void {
  for (const execution of executions) {
    const current = state.backgroundJobBoard.get(execution.taskID);
    if (!current || current.generation !== execution.generation) {
      log('[task-session-manager] skipped stale terminal execution', {
        parentSessionID,
        execution,
        currentGeneration: current?.generation,
      });
      continue;
    }
    state.backgroundJobBoard.markReconciled(execution.taskID);
  }
}

export function rememberInjectedTerminalJobs(
  state: InjectionState,
  parentSessionID: string,
  executions: readonly BackgroundJobExecution[],
  promptShapeKey: string,
): void {
  if (!parentSessionID || executions.length === 0) return;

  const uniqueExecutions = new Map(
    executions.map((execution) => [executionKey(execution), execution]),
  );
  if (uniqueExecutions.size === 0) return;

  const existing = state.terminalJobsInjectedByParent.get(parentSessionID);
  if (existing && existing.promptShapeKey === promptShapeKey) {
    // Same prompt shape: union the executions delivered by each payload.
    for (const [key, execution] of uniqueExecutions) {
      existing.executions.set(key, { ...execution });
    }
  } else {
    // A different shape is normally reconciled before this point. Replace
    // the entry defensively so executions from an older payload cannot leak
    // into the new delivered batch.
    state.terminalJobsInjectedByParent.set(parentSessionID, {
      executions: new Map(
        [...uniqueExecutions].map(([key, execution]) => [
          key,
          { ...execution },
        ]),
      ),
      promptShapeKey,
    });
  }

  const pending =
    state.pendingInjectedTerminalJobsByParent.get(parentSessionID);
  if (pending) {
    for (const key of uniqueExecutions.keys()) pending.delete(key);
    if (pending.size === 0) {
      state.pendingInjectedTerminalJobsByParent.delete(parentSessionID);
    }
  }

  log('[task-session-manager] terminal jobs injected for reconciliation', {
    parentSessionID,
    executions: [...uniqueExecutions.values()],
    promptShapeKey,
  });
}

export function reconcileInjectedTerminalJobs(
  state: InjectionState,
  parentSessionID: string,
): void {
  const entry = state.terminalJobsInjectedByParent.get(parentSessionID);
  const pending =
    state.pendingInjectedTerminalJobsByParent.get(parentSessionID);
  if (!entry && !pending) return;

  const executions = new Map<string, BackgroundJobExecution>();
  for (const [key, execution] of entry?.executions ?? []) {
    executions.set(key, execution);
  }
  for (const [key, execution] of pending ?? []) {
    executions.set(key, execution);
  }

  log('[task-session-manager] reconciling injected terminal jobs', {
    parentSessionID,
    executions: [...executions.values()],
  });

  reconcileExecutionBatch(state, parentSessionID, executions.values());
  state.terminalJobsInjectedByParent.delete(parentSessionID);
  state.pendingInjectedTerminalJobsByParent.delete(parentSessionID);
}

function reconcileConsumedTerminalJobs(
  state: InjectionState,
  parentSessionID: string,
  promptShapeKey: string,
): void {
  const entry = state.terminalJobsInjectedByParent.get(parentSessionID);
  if (!entry || entry.promptShapeKey === promptShapeKey) return;
  // The model produced at least one new part after the request that carried
  // these completions, so it has consumed that shaped delivery. Pending
  // synthetic completions belong to a later delivery and remain pending.
  log('[task-session-manager] reconciling consumed terminal jobs', {
    parentSessionID,
    executions: [...entry.executions.values()],
  });
  reconcileExecutionBatch(state, parentSessionID, entry.executions.values());
  state.terminalJobsInjectedByParent.delete(parentSessionID);
}

export async function injectBackgroundJobBoard(
  state: InjectionState,
  _input: Record<string, never>,
  output: { messages?: unknown },
): Promise<void> {
  const messages = Array.isArray(output.messages) ? output.messages : [];

  if (state.strategy === 'checkpoint-compatible') {
    injectCheckpointBoard(state, messages);
    return;
  }

  injectLatestBoard(state, messages);
}

/**
 * `latest` strategy: keep exactly one FRESH board on the current tail while
 * every board already sent on an earlier (now mid-history) message stays put,
 * byte-identical.
 *
 * The board is never persisted, so opencode rebuilds real history board-free
 * each request. That means the plugin — not storage — must reproduce every
 * board it previously placed. The prior implementation instead STRIPPED the
 * old tail's board and re-appended a fresh board on the new tail
 * (`stripTailBoardContent` + append). Because the old tail was already sent to
 * the provider WITH its board, dropping it rewrote an already-cached message
 * and invalidated the provider prompt-cache prefix from that message onward —
 * the whole tail re-cached every turn (field bust: ses_11145863 dumps
 * 000086→000087, old-tail user message 1376B→652B as its board vanished).
 *
 * Fix (append-only w.r.t. already-sent messages):
 *   1. Strip the board ONLY from the current tail zone (the tail message's
 *      trailing board part + whole synthetic board messages trailing it). That
 *      zone re-caches every turn, so rewriting it is byte-safe.
 *   2. Replay every FROZEN board (one placed on a message that is no longer the
 *      tail) byte-identically on its original anchor, so an already-sent board
 *      never disappears.
 *   3. Add ONE fresh board to the current tail, preserving the #889 placement
 *      (trailing PART on a user tail; separate trailing message on an assistant
 *      tail) so the tail breakpoint still lands on stable content, and record
 *      it so the NEXT request can freeze/replay it once the tail advances.
 * A board on any earlier message is never mutated or stripped.
 */
function injectLatestBoard(state: InjectionState, messages: unknown[]): void {
  // The current tail anchor: the last real (non-fully-tagged) message. It is
  // the ONLY message whose board is volatile — the tail re-caches anyway, so
  // freshening its board is free. Every earlier message was already sent, so
  // its board must never change.
  const anchor = findBoardAnchor(messages, state.metadataKey);
  const anchorId = anchor?.id;

  // Strip the board from the current tail zone only (byte-safe volatile zone).
  stripCurrentTailBoard(messages, state.metadataKey, anchor?.message);

  // Eligibility is driven by the most recent orchestrator user message (the
  // triggering turn), which also guards against specialist/internal turns.
  const trigger = findTriggeringUserMessage(messages, state.metadataKey);
  const sessionID = trigger?.info.sessionID;

  // Replay frozen boards even when this turn is ineligible for a fresh board
  // (internal-initiator turn, empty board): an already-sent board must stay put
  // regardless of the current turn. The current tail anchor is skipped — its
  // board is (re)placed fresh below.
  if (sessionID !== undefined) {
    replayRetainedTailBoards(state, sessionID, messages, anchorId);
  }

  if (!trigger) return;
  if (trigger.info.agent && trigger.info.agent !== 'orchestrator') return;
  if (!sessionID || !state.shouldManageSession(sessionID)) return;
  if (!anchor) return;

  const shapeKey = promptShapeKey(realMessages(messages, state.metadataKey));
  reconcileConsumedTerminalJobs(state, sessionID, shapeKey);

  const boardMeta =
    state.backgroundJobBoard.formatForPromptWithMetadata(sessionID);
  const reminder = boardMeta?.text;
  if (!reminder) return;

  const textPart = trigger.parts.find(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
  if (!textPart || isInternalInitiatorPart(textPart)) return;

  rememberInjectedTerminalJobs(
    state,
    sessionID,
    boardMeta.terminalUnreconciledTaskIDs,
    shapeKey,
  );

  // Placement rules — correctness first, then prompt-cache safety.
  //
  // Correctness (invariants A1-A3): the transformed array is converted to
  // `ModelMessage[]` and schema-validated before the request is sent, and a
  // violation raises `AI_InvalidPromptError` ("The messages do not match the
  // ModelMessage[] schema") before the HTTP call — a hard, unrecoverable turn
  // failure. Two rules keep the array valid:
  //
  //   * board text only ever rides on a `user` message (A3). The assistant
  //     branch of the host's converter forwards `part.metadata` as
  //     `providerMetadata`/`providerOptions`, which must be a nested record; a
  //     board part's `{ '<key>': true }` is a boolean and fails validation. The
  //     user branch drops metadata entirely, so it is safe.
  //   * a synthetic board MESSAGE is only ever appended at the very END of the
  //     array (A1). Inserting one mid-array can land between an assistant
  //     `task` tool_call and its tool_result and break the pairing the schema
  //     requires (A2); appending at the end cannot (A2 holds by construction).
  //
  // Cache safety (within the above):
  //
  // Provider caches read from the last two messages (Anthropic:
  // provider/transform.ts applyCaching → final.slice(-2)), and the provider
  // SDK coalesces adjacent same-role messages. A board injected as its own
  // trailing `user` message merges into a preceding user text message,
  // collapsing both tail breakpoints onto the merged block — so the only
  // readable breakpoint sits on the volatile board. Because the board moves to
  // a new tail every request, the deepest reusable breakpoint regresses to the
  // stable system boundary and the entire tail re-writes as cache every call.
  //
  // - If the tail is a user message, append the board as its trailing PART: the
  //   message COUNT stays identical to a board-free render, so the second tail
  //   breakpoint lands on the previous (byte-stable, real) message. This is
  //   also the only placement replayable later without inserting a message
  //   mid-array, so it is the only one recorded for replay.
  // - If the tail is an assistant message, a separate trailing USER board
  //   message is appended at the very end of the array. It does not merge
  //   (different role), so the assistant message keeps its own readable
  //   breakpoint, and it uses the USER `trigger.info` — never `anchor.info` —
  //   so the message carrying board text is genuinely user-role (A3).
  const recordId = anchor.id;
  if (canCarryBoardPart(anchor.message)) {
    appendTaggedSyntheticPart(anchor.message, {
      text: reminder,
      metadataKey: state.metadataKey,
    });
    // Recording the placement under the tail's anchor id lets the NEXT request
    // (once the tail advances) replay this exact board on this exact message,
    // so the bytes the provider just cached for this message never change.
    rememberTailBoard(state, sessionID, {
      anchorId: recordId,
      anchorRole: 'user',
      text: reminder,
    });
  } else {
    appendTrailingVolatileMessage(
      messages,
      {
        ...trigger.info,
        id: `${trigger.info.id ?? 'board'}-background-job-board`,
      },
      {
        text: reminder,
        metadataKey: state.metadataKey,
      },
    );
    // A5: this placement is deliberately NOT retained for replay. Reproducing
    // it once the tail advances would require splicing a message back into the
    // middle of the array, which is exactly what orphaned an assistant
    // tool_call from its tool_result and made the whole request invalid. A
    // cache bust (the board's bytes move to the new tail) is strictly
    // preferable to a hard `AI_InvalidPromptError`, so the board is simply
    // re-rendered on the new tail instead. Any stale entry for this anchor is
    // dropped so the retained map cannot grow or retry the unsafe placement.
    forgetTailBoard(state, sessionID, recordId);
  }
}

/** The last real (non-fully-tagged) message — the current tail anchor. */
function findBoardAnchor(
  messages: unknown[],
  metadataKey: string,
): BoardAnchor | undefined {
  return boardAnchors(messages, metadataKey).at(-1);
}

/**
 * Strip the board ONLY from the current tail zone: whole synthetic board
 * messages trailing the payload, plus a trailing board part on the current
 * tail anchor. This is the volatile zone (the tail re-caches every turn), so
 * rewriting it is byte-safe. A board on any earlier message is untouched —
 * removing it would rewrite already-sent, already-cached bytes.
 */
function stripCurrentTailBoard(
  messages: unknown[],
  metadataKey: string,
  anchor: MessageWithParts | undefined,
): void {
  // Drop whole synthetic board messages trailing the payload.
  let i = messages.length - 1;
  while (i >= 0) {
    const message = messages[i];
    if (!isVolatileTaggedMessage(message, metadataKey)) break;
    messages.splice(i, 1);
    i -= 1;
  }

  // Strip a trailing board part from the current tail anchor only.
  if (anchor) {
    anchor.parts = anchor.parts.filter(
      (part) => !isTaggedPart(part, metadataKey),
    );
  }
}

/**
 * A stable id for an anchor message that lacks an `info.id` (test fixtures,
 * legacy shapes). Derived from role + concatenated REAL text (tagged board
 * parts excluded) plus its append-order occurrence, so duplicate anonymous
 * messages remain distinct while appending a later message leaves existing
 * ids unchanged. The occurrence is internal and never enters the payload.
 */
function boardAnchorFallbackId(
  message: MessageWithParts,
  occurrence: number,
  metadataKey: string,
): string {
  return `anon:${djb2Hash(boardAnchorFallbackBase(message, metadataKey))}:${occurrence}`;
}

function boardAnchorFallbackBase(
  message: MessageWithParts,
  metadataKey: string,
): string {
  const text = message.parts
    .filter(
      (part) =>
        !isTaggedPart(part, metadataKey) &&
        part.type === 'text' &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\u0000');
  return `${message.info.role}:${text}`;
}

/**
 * Build internal anchor identities in append order. Anonymous messages use an
 * occurrence suffix so duplicate content remains distinct, while appending a
 * later message leaves all existing identities unchanged. The identity never
 * enters the provider-visible message payload.
 */
function boardAnchors(messages: unknown[], metadataKey: string): BoardAnchor[] {
  const occurrences = new Map<string, number>();
  const anchors: BoardAnchor[] = [];

  for (const candidate of messages) {
    if (!isMessageWithParts(candidate)) continue;
    if (
      candidate.parts.length > 0 &&
      candidate.parts.every((part) => isTaggedPart(part, metadataKey))
    ) {
      continue;
    }

    if (candidate.info.id !== undefined) {
      anchors.push({ message: candidate, id: candidate.info.id });
      continue;
    }

    const base = boardAnchorFallbackBase(candidate, metadataKey);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    anchors.push({
      message: candidate,
      id: boardAnchorFallbackId(candidate, occurrence, metadataKey),
    });
  }

  return anchors;
}

/** Record (or refresh) a board placed on an anchor for later replay. */
function rememberTailBoard(
  state: InjectionState,
  sessionID: string,
  board: RetainedTailBoard,
): void {
  const perSession =
    state.retainedTailBoards.get(sessionID) ??
    new Map<string, RetainedTailBoard>();
  perSession.set(board.anchorId, board);
  state.retainedTailBoards.set(sessionID, perSession);
}

/**
 * Stop tracking a retained board for an anchor (A5). Used when the placement
 * cannot be safely reproduced, so the map neither grows without bound nor
 * retries an unsafe replay on every later request.
 */
function forgetTailBoard(
  state: InjectionState,
  sessionID: string,
  anchorId: string,
): void {
  const perSession = state.retainedTailBoards.get(sessionID);
  if (!perSession) return;
  perSession.delete(anchorId);
  if (perSession.size === 0) state.retainedTailBoards.delete(sessionID);
}

/**
 * Re-append every FROZEN retained board onto its original anchor message,
 * exactly as first sent, so a board that was sent on a message which is no
 * longer the tail never disappears (its bytes are already in the provider's
 * cached prefix).
 *
 * Replay is strictly append-a-PART-to-an-existing-message. It never inserts a
 * message (A1) and therefore can never come between a tool_call and its
 * tool_result (A2), and it only ever targets a `user` message (A3).
 *
 * A retained board whose anchor cannot satisfy those invariants is DROPPED
 * (A5) rather than reproduced: losing a stale board costs one cache bust,
 * whereas an invalid message array raises `AI_InvalidPromptError` during
 * request validation and fails the turn outright.
 *
 * The current tail anchor (`currentAnchorId`) is skipped: its board is volatile
 * and is (re)placed fresh by the caller. Anchors no longer present in history
 * (compaction, revert) are pruned — their bytes are gone from the provider's
 * view too. Replay is skipped when the anchor already carries a board, keeping
 * the operation idempotent under repeated transforms on a shared array.
 */
function replayRetainedTailBoards(
  state: InjectionState,
  sessionID: string,
  messages: unknown[],
  currentAnchorId: string | undefined,
): void {
  const perSession = state.retainedTailBoards.get(sessionID);
  if (!perSession || perSession.size === 0) return;

  const anchorById = new Map<string, MessageWithParts>();
  for (const anchor of boardAnchors(messages, state.metadataKey)) {
    anchorById.set(anchor.id, anchor.message);
  }

  for (const [anchorId, board] of [...perSession.entries()]) {
    // The current tail's board is volatile — the caller strips and re-appends
    // it. Never freeze/replay it here.
    if (anchorId === currentAnchorId) continue;

    const anchor = anchorById.get(anchorId);
    if (!anchor) {
      // Anchor gone from history (compaction/revert): its bytes are no longer
      // in the provider's view, so stop tracking it.
      perSession.delete(anchorId);
      continue;
    }
    if (hasTaggedPart(anchor, state.metadataKey)) continue;

    // A5: only the trailing-PART-on-a-user-anchor placement is replayable. A
    // board recorded against an assistant anchor (legacy state from an earlier
    // build) was reproduced by splicing a synthetic message after the anchor —
    // which lands between an assistant `task` tool_call and its tool_result and
    // invalidates the whole request. A board whose anchor is no longer a user
    // message cannot take the part path either. Both are dropped: one lost
    // board (a bounded cache bust on that message) is preferable to a hard
    // AI_InvalidPromptError on every request.
    if (board.anchorRole !== 'user' || !canCarryBoardPart(anchor)) {
      perSession.delete(anchorId);
      continue;
    }

    appendTaggedSyntheticPart(anchor, {
      text: board.text,
      metadataKey: state.metadataKey,
    });
  }

  if (perSession.size === 0) state.retainedTailBoards.delete(sessionID);
}

/**
 * The most recent real (non-board) user message that carries a text part —
 * used only to validate injection eligibility and derive session/text context.
 * Tool-result-only user turns (no text part) are skipped so a long tool loop
 * still resolves the triggering orchestrator turn. Board placement targets the
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

function injectCheckpointBoard(
  state: InjectionState,
  messages: unknown[],
): void {
  const currentMessages = realMessages(messages, state.metadataKey);
  const shapeKey = promptShapeKey(currentMessages);
  const tailMessage = currentMessages.at(-1);
  const sessionID = tailMessage?.info.sessionID;
  if (!tailMessage || !sessionID || !state.shouldManageSession(sessionID)) {
    return;
  }

  const triggeringMessage = currentMessages.findLast(
    (message) =>
      isUserMessageWithParts(message) && message.info.sessionID === sessionID,
  );
  const textPart = triggeringMessage?.parts.find(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
  const canSurface =
    triggeringMessage !== undefined &&
    (!triggeringMessage.info.agent ||
      triggeringMessage.info.agent === 'orchestrator') &&
    textPart !== undefined &&
    !isInternalInitiatorPart(textPart);

  if (canSurface) reconcileConsumedTerminalJobs(state, sessionID, shapeKey);

  const boardMeta =
    state.backgroundJobBoard.formatForPromptWithMetadata(sessionID);
  const reminder = boardMeta?.text;
  const canCreateSnapshot = canSurface && reminder !== undefined;

  const replayBaseMessage = triggeringMessage ?? tailMessage;
  const snapshotState = updateBoardHistoryState(
    state,
    sessionID,
    currentMessages,
  );

  if (canCreateSnapshot && reminder) {
    const anchorKey = findLastMessageAnchorKey(currentMessages);
    const previousSnapshot = snapshotState.snapshots.at(-1);
    const sameSnapshot =
      previousSnapshot?.text === reminder &&
      sameExecutionIdentity(
        previousSnapshot.terminalUnreconciledTaskIDs,
        boardMeta.terminalUnreconciledTaskIDs,
      );
    if (anchorKey && !sameSnapshot) {
      const encodedSessionID = encodeURIComponent(sessionID);
      const sequence = snapshotState.nextSnapshotSequence;
      snapshotState.nextSnapshotSequence += 1;
      if (snapshotState.snapshots.length >= state.maxRetainedSnapshots) {
        // Deliberately start a new cache epoch at the configured boundary.
        snapshotState.snapshots.length = 0;
      }
      snapshotState.snapshots.push({
        anchorKey,
        id: `oh-my-opencode-slim:background-job-board:${encodedSessionID}:${sequence}`,
        text: reminder,
        terminalUnreconciledTaskIDs: boardMeta.terminalUnreconciledTaskIDs,
      });
    }
  }

  const replayedIDs = replayCheckpointBoard(
    messages,
    replayBaseMessage,
    sessionID,
    snapshotState,
    state.metadataKey,
  );
  if (replayedIDs.length > 0) {
    rememberInjectedTerminalJobs(state, sessionID, replayedIDs, shapeKey);
  }
}

function findLastMessageAnchorKey(
  messages: MessageWithParts[],
): string | undefined {
  return messageAnchorKeys(messages).at(-1);
}

function boardHistoryMessageSignature(message: MessageWithParts): string {
  const text = message.parts
    .filter(
      (part) =>
        part.synthetic !== true &&
        part.type === 'text' &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
  return `${message.info.role}:${message.info.agent ?? ''}:${text}`;
}

function messageAnchorKeys(messages: MessageWithParts[]): string[] {
  const occurrences = new Map<string, number>();
  return messages.map((message) => {
    const base = message.info.id
      ? `id:${message.info.id}`
      : `anonymous:${boardHistoryMessageSignature(message)}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return `${base}:${occurrence}`;
  });
}

function realMessages(
  messages: unknown[],
  metadataKey: string,
): MessageWithParts[] {
  return messages.flatMap((message) => {
    if (!isMessageWithParts(message)) return [];
    const parts = message.parts.filter(
      (part) => !isTaggedPart(part, metadataKey),
    );
    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}

/**
 * Identity of the real prompt content/structure for one request. Stable across
 * repeated transforms of the same request; changes as soon as relevant message
 * or non-synthetic part content changes. Counts alone are insufficient because
 * supported compaction can remove old content while a model turn appends new
 * content, preserving message/part counts.
 */
function promptShapeKey(realMessageList: MessageWithParts[]): string {
  const tokens: string[] = [];
  tokens.push(`messages:${realMessageList.length}`);
  for (const message of realMessageList) {
    tokens.push('message');
    tokens.push(`role:${message.info.role ?? ''}`);
    tokens.push(`agent:${message.info.agent ?? ''}`);
    tokens.push(`session:${message.info.sessionID ?? ''}`);
    const realParts = message.parts.filter((part) => part.synthetic !== true);
    tokens.push(`parts:${realParts.length}`);
    for (const part of realParts) {
      tokens.push('part');
      tokens.push(stablePromptPartSignature(part));
    }
  }
  return sha256Hash(tokens.join('\u001f'));
}

function stablePromptPartSignature(part: MessagePart): string {
  return stableSerializePromptValue(part);
}

function stableSerializePromptValue(value: unknown): string {
  if (value === null) return 'null';
  const valueType = typeof value;
  if (valueType === 'string') return JSON.stringify(value);
  if (valueType === 'number' || valueType === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializePromptValue(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableSerializePromptValue(value[key])}`,
      )
      .join(',')}}`;
  }
  return valueType;
}

function hasCompacted(
  previous: RetainedBoardSnapshotState,
  currentMessages: MessageWithParts[],
): boolean {
  if (currentMessages.length < previous.realMessageCount) return true;

  const currentAnchorKeys = messageAnchorKeys(currentMessages);
  return (
    (currentAnchorKeys[0] !== undefined &&
      previous.firstRealMessageAnchorKey !== undefined &&
      currentAnchorKeys[0] !== previous.firstRealMessageAnchorKey) ||
    previous.snapshots.some(
      (snapshot) => !currentAnchorKeys.includes(snapshot.anchorKey),
    )
  );
}

function updateBoardHistoryState(
  state: InjectionState,
  sessionID: string,
  messages: MessageWithParts[],
): RetainedBoardSnapshotState {
  const previous = state.retainedBoardSnapshots.get(sessionID);
  if (previous && hasCompacted(previous, messages)) {
    state.retainedBoardSnapshots.delete(sessionID);
  }

  const current = state.retainedBoardSnapshots.get(sessionID) ?? {
    snapshots: [],
    nextSnapshotSequence: 0,
    realMessageCount: 0,
    firstRealMessageAnchorKey: undefined,
  };
  const currentAnchorKeys = messageAnchorKeys(messages);
  current.realMessageCount = messages.length;
  current.firstRealMessageAnchorKey = currentAnchorKeys[0];
  state.retainedBoardSnapshots.set(sessionID, current);
  return current;
}

function createBoardMessage(
  baseMessage: MessageWithParts,
  sessionID: string,
  snapshot: RetainedBoardSnapshot,
  metadataKey: string,
  usedMessageIDs: Set<string>,
): MessageWithParts {
  const baseID = snapshot.id;
  let id = baseID;
  let collisionIndex = 1;
  while (usedMessageIDs.has(id)) {
    id = `${baseID}:collision-${collisionIndex}`;
    collisionIndex += 1;
  }
  usedMessageIDs.add(id);
  return {
    info: { ...baseMessage.info, id },
    parts: [
      createTaggedSyntheticPart({
        text: snapshot.text,
        metadataKey,
        extraMetadata: { sessionID, snapshotID: snapshot.id },
      }),
    ],
  };
}

function replayBoardSnapshots(
  messages: unknown[],
  baseMessage: MessageWithParts,
  sessionID: string,
  snapshotState: RetainedBoardSnapshotState,
  metadataKey: string,
): BackgroundJobExecution[] {
  const realMessageList = realMessages(messages, metadataKey);
  const currentAnchorKeys = messageAnchorKeys(realMessageList);
  const snapshotsByAnchor = new Map<string, RetainedBoardSnapshot[]>();
  for (const snapshot of snapshotState.snapshots) {
    const snapshots = snapshotsByAnchor.get(snapshot.anchorKey) ?? [];
    snapshots.push(snapshot);
    snapshotsByAnchor.set(snapshot.anchorKey, snapshots);
  }

  const usedMessageIDs = new Set(
    messages.flatMap((message) =>
      isMessageWithParts(message) && message.info.id ? [message.info.id] : [],
    ),
  );

  const rebuiltMessages: unknown[] = [];
  const replayedIDs: BackgroundJobExecution[] = [];
  let realMessageIndex = 0;
  for (const message of messages) {
    rebuiltMessages.push(message);
    if (!isMessageWithParts(message) || message.parts.length === 0) continue;
    if (message.parts.every((part) => isTaggedPart(part, metadataKey))) {
      continue;
    }

    const anchorKey = currentAnchorKeys[realMessageIndex];
    if (!anchorKey) continue;
    realMessageIndex += 1;
    for (const snapshot of snapshotsByAnchor.get(anchorKey) ?? []) {
      rebuiltMessages.push(
        createBoardMessage(
          baseMessage,
          sessionID,
          snapshot,
          metadataKey,
          usedMessageIDs,
        ),
      );
      if (snapshot.terminalUnreconciledTaskIDs?.length) {
        replayedIDs.push(...snapshot.terminalUnreconciledTaskIDs);
      }
    }
  }

  messages.splice(0, messages.length, ...rebuiltMessages);
  return replayedIDs;
}

function replayCheckpointBoard(
  messages: unknown[],
  baseMessage: MessageWithParts,
  sessionID: string,
  snapshotState: RetainedBoardSnapshotState,
  metadataKey: string,
): BackgroundJobExecution[] {
  stripTaggedContent(messages, metadataKey);
  const ids = replayBoardSnapshots(
    messages,
    baseMessage,
    sessionID,
    snapshotState,
    metadataKey,
  );
  return ids;
}
