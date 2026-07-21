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
import { isInternalInitiatorPart, parseTaskStatusOutput } from '../../utils';
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

    if (state.strategy === 'checkpoint-compatible') {
      injectCheckpointBoard(state, messages, message, reminder);
      return;
    }

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
  message: MessageWithParts,
  reminder: string,
): void {
  const sessionID = message.info.sessionID;
  if (!sessionID) return;
  const currentMessages = realMessages(messages, state.metadataKey);
  const snapshotState = updateBoardHistoryState(
    state,
    sessionID,
    currentMessages,
  );
  const anchorKey = findMessageAnchorKey(currentMessages, message);
  if (!anchorKey) return;

  if (snapshotState.snapshots.at(-1)?.text !== reminder && reminder) {
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
  replayCheckpointBoard(
    messages,
    message,
    sessionID,
    snapshotState,
    state.metadataKey,
  );
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

function findMessageAnchorKey(
  messages: MessageWithParts[],
  message: MessageWithParts,
): string | undefined {
  const anchorKeys = messageAnchorKeys(messages);
  const messageID = message.info.id;
  if (messageID) {
    const index = messages.findIndex(
      (candidate) => candidate.info.id === messageID,
    );
    return index >= 0 ? anchorKeys[index] : undefined;
  }

  const signature = boardHistoryMessageSignature(message);
  const index = messages.findLastIndex(
    (candidate) => boardHistoryMessageSignature(candidate) === signature,
  );
  return index >= 0 ? anchorKeys[index] : undefined;
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
