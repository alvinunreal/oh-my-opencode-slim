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

/**
 * A board the `latest` strategy has already placed (and therefore already sent
 * to the provider) on a specific anchor message. Replayed byte-identically on
 * every later request once that anchor is no longer the tail, so a board that
 * was sent on a message the provider has cached never disappears. `anchorRole`
 * records how it was placed: a `user` anchor carried the board as a trailing
 * PART; an `assistant` anchor was followed by a separate synthetic board
 * message.
 */
type RetainedTailBoard = {
  anchorId: string;
  anchorRole: string;
  text: string;
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
  const anchorId = anchor ? boardAnchorId(anchor) : undefined;

  // Strip the board from the current tail zone only (byte-safe volatile zone).
  stripCurrentTailBoard(messages, state.metadataKey, anchor);

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

  const reminder = state.backgroundJobBoard.formatForPrompt(sessionID);
  if (!reminder) return;

  const textPart = trigger.parts.find(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
  if (!textPart || isInternalInitiatorPart(textPart)) return;

  rememberInjectedTerminalJobs(state, sessionID);

  // Placement rules (prompt-cache safety):
  //
  // Provider caches read from the last two messages (Anthropic:
  // provider/transform.ts applyCaching → final.slice(-2)), and the provider
  // SDK coalesces adjacent same-role messages. A board injected as its own
  // trailing `user` message merges into a preceding user tool_result message,
  // collapsing both tail breakpoints onto the merged block — so the only
  // readable breakpoint sits on the volatile board. Because the board moves to
  // a new tail every request, the deepest reusable breakpoint regresses to the
  // stable system boundary and the entire tail re-writes as cache every call.
  //
  // - If the tail is a user message, append the board as its trailing PART:
  //   the message COUNT stays identical to a board-free render, so the second
  //   tail breakpoint lands on the previous (byte-stable, real) message.
  // - If the tail is an assistant message, a separate trailing user board
  //   message does NOT merge (different role), so the assistant message keeps
  //   its own readable breakpoint.
  //
  // Recording the placement under the tail's anchor id lets the NEXT request
  // (once the tail advances) replay this exact board on this exact message, so
  // the bytes the provider just cached for this message never change.
  const recordId = anchorId ?? boardAnchorFallbackId(anchor);
  if (anchor.info.role === 'user') {
    appendTaggedSyntheticPart(anchor, {
      text: reminder,
      metadataKey: state.metadataKey,
    });
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
    rememberTailBoard(state, sessionID, {
      anchorId: recordId,
      anchorRole: 'assistant',
      text: reminder,
    });
  }
}

/** The last real (non-fully-tagged) message — the current tail anchor. */
function findBoardAnchor(
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
    return message;
  }
  return undefined;
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
 * parts excluded) so the id is identical whether or not a board currently
 * rides on the message — otherwise appending a board would change the id and
 * defeat cross-request anchor matching.
 */
function boardAnchorFallbackId(message: MessageWithParts): string {
  const text = message.parts
    .filter(
      (part) =>
        !isTaggedPart(part, BACKGROUND_JOB_BOARD_METADATA_KEY) &&
        part.type === 'text' &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\u0000');
  return `anon:${djb2Hash(`${message.info.role}:${text}`)}`;
}

/** The id used to key a message in the retained-tail-board log. */
function boardAnchorId(message: MessageWithParts): string {
  return message.info.id ?? boardAnchorFallbackId(message);
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
 * Re-append every FROZEN retained board onto its original anchor message,
 * exactly as first sent, so a board that was sent on a message which is no
 * longer the tail never disappears (its bytes are already in the provider's
 * cached prefix).
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
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    if (
      message.parts.length > 0 &&
      message.parts.every((part) => isTaggedPart(part, state.metadataKey))
    ) {
      continue;
    }
    anchorById.set(boardAnchorId(message), message);
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
    if (board.anchorRole === 'user') {
      appendTaggedSyntheticPart(anchor, {
        text: board.text,
        metadataKey: state.metadataKey,
      });
    } else {
      // Assistant anchor: the board was a separate synthetic message that
      // immediately followed the anchor. Reinsert it right after the anchor so
      // its position (and therefore the cached byte offset) is reproduced.
      const index = messages.indexOf(anchor);
      const boardMessage: MessageWithParts = {
        info: { ...anchor.info, id: `${anchorId}-background-job-board` },
        parts: [
          createTaggedSyntheticPart({
            text: board.text,
            metadataKey: state.metadataKey,
          }),
        ],
      };
      messages.splice(index + 1, 0, boardMessage);
    }
  }
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
