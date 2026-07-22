/**
 * Board injection subsystem for task session manager.
 *
 * Handles injecting Background Job Board state into the message stream
 * and processing synthetic injected completions.
 *
 * All injection logic must go through the cache-safe helpers in
 * ../cache-safe-injection.ts to ensure prompt cache safety.
 */
import type {
  BackgroundJobRecord,
  BackgroundJobStore,
  ContextFile,
} from '../../utils';
import {
  isInternalInitiatorPart,
  parseTaskStatusOutput,
  renderRunningTaskPlaceholder,
  renderTaskTerminalFromBoard,
} from '../../utils';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  appendTrailingVolatileMessage,
  createTaggedSyntheticPart,
  isTaggedPart,
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

export const MAX_PROCESSED_INJECTED_COMPLETIONS = 500;

type RetainedBoardSnapshot = {
  anchorKey: string;
  id: string;
  text: string;
};

export type RetainedBoardSnapshotState = {
  snapshots: RetainedBoardSnapshot[];
  nextSnapshotSequence: number;
  realMessageCount: number;
  firstRealMessageAnchorKey?: string;
};

// ── State shape ────────────────────────────────────────────────────────

export interface InjectionState {
  backgroundJobBoard: BackgroundJobStore;
  maxRetainedSnapshots: number;
  strategy: 'latest' | 'checkpoint-compatible';
  processedInjectedCompletions: Set<string>;
  processedInjectedCompletionOrder: string[];
  terminalJobsInjectedByParent: Map<string, Set<string>>;
  maxProcessedInjectedCompletions: number;
  metadataKey: string;
  shouldManageSession: (sessionID: string) => boolean;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
  retainedBoardSnapshots: Map<string, RetainedBoardSnapshotState>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function createOccurrenceId(
  part: MessagePart,
  message: MessageWithParts,
  partIndex: number,
): string {
  if (typeof part.id === 'string') {
    return part.id;
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
    log('[task-session-manager] synthetic part missing task status', {
      textPreview: part.text.slice(0, 120),
    });
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
    rememberProcessedInjectedCompletion(state, occurrenceId);
    return existing;
  }

  if (isCompleted && status.state !== 'completed') return undefined;
  if (isFailed && status.state !== 'error') return undefined;

  if (state.processedInjectedCompletions.has(occurrenceId)) return undefined;

  const updated = updateBackgroundJobFromOutput(
    part.text,
    state.backgroundJobBoard,
    state.taskContextTracker,
  );
  if (!updated) return undefined;

  log('[task-session-manager] processed injected background completion', {
    taskID: updated.taskID,
    alias: updated.alias,
    parentSessionID: updated.parentSessionID,
    state: updated.state,
    occurrenceId,
  });

  rememberProcessedInjectedCompletion(state, occurrenceId);
  return updated;
}

export function rememberProcessedInjectedCompletion(
  state: InjectionState,
  signature: string,
): void {
  state.processedInjectedCompletions.add(signature);
  state.processedInjectedCompletionOrder.push(signature);

  while (
    state.processedInjectedCompletionOrder.length >
    state.maxProcessedInjectedCompletions
  ) {
    const evicted = state.processedInjectedCompletionOrder.shift();
    if (!evicted) break;
    state.processedInjectedCompletions.delete(evicted);
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

export function rememberInjectedTerminalJobs(
  state: InjectionState,
  parentSessionID: string,
): void {
  const taskIDs = state.backgroundJobBoard
    .list(parentSessionID)
    .filter((job) => job.terminalUnreconciled)
    .map((job) => job.taskID);
  if (taskIDs.length === 0) return;

  log('[task-session-manager] terminal jobs injected for reconciliation', {
    parentSessionID,
    taskIDs,
  });

  const existing =
    state.terminalJobsInjectedByParent.get(parentSessionID) ??
    new Set<string>();
  for (const taskID of taskIDs) {
    existing.add(taskID);
  }
  state.terminalJobsInjectedByParent.set(parentSessionID, existing);
}

export function reconcileInjectedTerminalJobs(
  state: InjectionState,
  parentSessionID: string,
): void {
  const taskIDs = state.terminalJobsInjectedByParent.get(parentSessionID);
  if (!taskIDs) return;

  log('[task-session-manager] reconciling injected terminal jobs', {
    parentSessionID,
    taskIDs: [...taskIDs],
  });

  for (const taskID of taskIDs) {
    state.backgroundJobBoard.markReconciled(taskID);
  }
  state.terminalJobsInjectedByParent.delete(parentSessionID);
}

export async function injectBackgroundJobBoard(
  state: InjectionState,
  _input: Record<string, never>,
  output: { messages?: unknown },
): Promise<void> {
  const messages = Array.isArray(output.messages) ? output.messages : [];

  if (state.strategy === 'latest') {
    // Strip previously injected board content: parts attached to real
    // messages (legacy placement) and whole synthetic board messages.
    stripTaggedContent(messages, state.metadataKey);
  }

  if (state.strategy === 'checkpoint-compatible') {
    injectCheckpointBoard(state, messages);
    return;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      isMessageWithParts(message) &&
      message.parts.length > 0 &&
      message.parts.every((part) => isTaggedPart(part, state.metadataKey))
    ) {
      continue;
    }
    if (!isUserMessageWithParts(message)) continue;
    if (message.info.agent && message.info.agent !== 'orchestrator') return;
    if (
      !message.info.sessionID ||
      !state.shouldManageSession(message.info.sessionID)
    ) {
      return;
    }

    const reminder = state.backgroundJobBoard.formatForPrompt(
      message.info.sessionID,
    );
    if (!reminder) return;

    const textPart = message.parts.find(
      (part) => part.type === 'text' && typeof part.text === 'string',
    );
    if (!textPart || isInternalInitiatorPart(textPart)) return;

    rememberInjectedTerminalJobs(state, message.info.sessionID);
    // Append the board as its own trailing message rather than mutating
    // an existing user message. In long tool loops the latest user
    // message becomes deep history; rewriting it on board state changes
    // would invalidate the provider prompt cache for everything after
    // it. A trailing message keeps board churn at the end of the
    // prompt, where it only costs itself.
    appendTrailingVolatileMessage(
      messages,
      {
        ...message.info,
        id: `${message.info.id}-background-job-board`,
      },
      {
        text: reminder,
        metadataKey: state.metadataKey,
      },
    );
    return;
  }
}

function injectCheckpointBoard(
  state: InjectionState,
  messages: unknown[],
): void {
  const currentMessages = realMessages(messages, state.metadataKey);
  const tailMessage = currentMessages.at(-1);
  const sessionID = tailMessage?.info.sessionID;
  if (!tailMessage || !sessionID || !state.shouldManageSession(sessionID)) {
    return;
  }

  const triggeringMessage = currentMessages.findLast(
    (message) =>
      isUserMessageWithParts(message) && message.info.sessionID === sessionID,
  );
  const reminder = state.backgroundJobBoard.formatForPrompt(sessionID);
  const textPart = triggeringMessage?.parts.find(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
  const canCreateSnapshot =
    triggeringMessage !== undefined &&
    (!triggeringMessage.info.agent ||
      triggeringMessage.info.agent === 'orchestrator') &&
    textPart !== undefined &&
    !isInternalInitiatorPart(textPart) &&
    reminder !== undefined;

  const replayBaseMessage = triggeringMessage ?? tailMessage;
  const snapshotState = updateBoardHistoryState(
    state,
    sessionID,
    currentMessages,
  );

  if (canCreateSnapshot && reminder) {
    const anchorKey = findLastMessageAnchorKey(currentMessages);
    if (anchorKey && snapshotState.snapshots.at(-1)?.text !== reminder) {
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
      });
    }
    rememberInjectedTerminalJobs(state, sessionID);
  }

  replayCheckpointBoard(
    messages,
    replayBaseMessage,
    sessionID,
    snapshotState,
    state.metadataKey,
  );
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
): void {
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
    }
  }

  messages.splice(0, messages.length, ...rebuiltMessages);
}

function replayCheckpointBoard(
  messages: unknown[],
  baseMessage: MessageWithParts,
  sessionID: string,
  snapshotState: RetainedBoardSnapshotState,
  metadataKey: string,
): void {
  stripTaggedContent(messages, metadataKey);
  replayBoardSnapshots(
    messages,
    baseMessage,
    sessionID,
    snapshotState,
    metadataKey,
  );
  // The caller records terminal jobs before this replay so that the normal
  // idle reconciliation path can consume them after the prompt is processed.
}
