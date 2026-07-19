import type { PluginInput } from '@opencode-ai/plugin';
import {
  BackgroundJobBoard,
  type BackgroundJobRecord,
  type BackgroundJobStore,
  createInternalAgentTextPart,
  deriveTaskSessionLabel,
  isInternalInitiatorPart,
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  appendTrailingVolatileMessage,
  stripTaggedContent,
} from '../cache-safe-injection';
import { isFailoverError } from '../foreground-fallback/index';
import type { SessionLifecycle } from '../session-lifecycle';
import {
  isUserMessageWithParts,
  type MessagePart,
  type MessageWithParts,
} from '../types';
import type { PendingTaskCall } from './pending-call-tracker';
import { createPendingCallTracker } from './pending-call-tracker';
import {
  createTaskContextTracker,
  extractReadFiles,
} from './task-context-tracker';

interface TaskArgs {
  description?: unknown;
  prompt?: unknown;
  subagent_type?: unknown;
  task_id?: unknown;
}

export const BACKGROUND_JOB_BOARD_METADATA_KEY =
  'oh-my-opencode-slim.backgroundJobBoard';
const BACKGROUND_COMPLETION_COMPLETED = /^Background task completed: /;
const BACKGROUND_COMPLETION_FAILED = /^Background task failed: /;
const MAX_PROCESSED_INJECTED_COMPLETIONS = 500;
const RAW_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;

/**
 * Delay before reconciling idle sessions.
 * Gives late injected completions time to arrive within this window.
 * Completions arriving after the window are still dropped (the race is reduced, not eliminated).
 * ponytail: fixed timeout — event-driven confirmation would fully close the race but adds
 * significant complexity for a case that rarely exceeds this window in practice.
 */
const IDLE_RECONCILE_DELAY_MS = 2_000;

const CONTINUATION_NUDGE =
  'Continue coordinating the remaining incomplete todos. Do not finalize while work remains.';
const IDLESS_INPUT_WAIT = Symbol('idless-input-wait');
const INPUT_WAIT_ASK_EVENTS = {
  'permission.asked': 'permission',
  'question.asked': 'question',
} as const;
const INPUT_WAIT_RESOLUTION_EVENTS = {
  'permission.replied': 'permission',
  'question.replied': 'question',
  'question.rejected': 'question',
} as const;

function isInputWaitAskEvent(
  type: string,
): type is keyof typeof INPUT_WAIT_ASK_EVENTS {
  return Object.hasOwn(INPUT_WAIT_ASK_EVENTS, type);
}

function isInputWaitResolutionEvent(
  type: string,
): type is keyof typeof INPUT_WAIT_RESOLUTION_EVENTS {
  return Object.hasOwn(INPUT_WAIT_RESOLUTION_EVENTS, type);
}

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

function extractTaskSummary(output: string): string | undefined {
  const summary = /<summary>\s*([\s\S]*?)\s*<\/summary>/i.exec(output)?.[1];
  return summary?.trim() || undefined;
}

export function createTaskSessionManagerHook(
  _ctx: PluginInput,
  options: {
    maxSessionsPerAgent: number;
    readContextMinLines?: number;
    readContextMaxFiles?: number;
    backgroundJobBoard?: BackgroundJobStore;
    shouldManageSession: (sessionID: string) => boolean;
    /** Register a session as orchestrator when the transform hook detects
     *  an orchestrator message but the session isn't in the agent map yet. */
    registerSessionAsOrchestrator?: (sessionID: string) => void;
    /** Optional guard: when provided, idle events for a session that is
     *  currently undergoing a foreground-fallback abort/re-prompt cycle
     *  will NOT trigger idle reconciliation. prevents marking a still-
     *  active child job as completed when the session was aborted for
     *  model fallback rather than natural completion. */
    isFallbackInProgress?: (sessionID: string) => boolean;
    coordinator?: SessionLifecycle;
    /** Test seam only; production always uses the reconciliation delay. */
    idleReconcileDelayMs?: number;
  },
) {
  const backgroundJobBoard =
    options.backgroundJobBoard ??
    new BackgroundJobBoard({
      maxReusablePerAgent: options.maxSessionsPerAgent,
      readContextMinLines: options.readContextMinLines,
      readContextMaxFiles: options.readContextMaxFiles,
    });

  const pendingCallTracker = createPendingCallTracker();
  const taskContextTracker = createTaskContextTracker();

  const processedInjectedCompletions = new Set<string>();
  const processedInjectedCompletionOrder: string[] = [];
  const terminalJobsInjectedByParent = new Map<string, Set<string>>();
  const idleReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const continuationSessionTokens = new Map<string, symbol>();
  const activeContinuationEvaluations = new Map<string, Set<symbol>>();
  const continuationConsumed = new Set<string>();
  const inputWaitsByParent = new Map<string, Set<string | symbol>>();
  const idleReconcileDelayMs =
    options.idleReconcileDelayMs ?? IDLE_RECONCILE_DELAY_MS;

  type SdkResponse = { data?: unknown };
  type SessionSdk = {
    todo?: (input: unknown) => Promise<SdkResponse>;
    children?: (input: unknown) => Promise<SdkResponse>;
    status?: (input: unknown) => Promise<SdkResponse>;
    promptAsync?: (input: unknown) => Promise<unknown>;
  };
  const sessionSdk = (_ctx.client as unknown as { session?: SessionSdk })
    .session;

  function getContinuationSessionToken(sessionID: string): symbol {
    const existing = continuationSessionTokens.get(sessionID);
    if (existing) return existing;

    const token = Symbol(sessionID);
    continuationSessionTokens.set(sessionID, token);
    return token;
  }

  function isCurrentContinuation(
    sessionID: string,
    sessionToken: symbol,
    evaluationToken?: symbol,
  ): boolean {
    return (
      continuationSessionTokens.get(sessionID) === sessionToken &&
      (evaluationToken === undefined ||
        activeContinuationEvaluations.get(sessionID)?.has(evaluationToken) ===
          true)
    );
  }

  function invalidateContinuation(sessionID: string): void {
    const timer = idleReconcileTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      idleReconcileTimers.delete(sessionID);
    }
    continuationSessionTokens.delete(sessionID);
    activeContinuationEvaluations.delete(sessionID);
  }

  function clearContinuation(sessionID: string): void {
    invalidateContinuation(sessionID);
    continuationConsumed.delete(sessionID);
  }

  function inputWaitKey(kind: 'permission' | 'question', requestID: string) {
    return `${kind}:${requestID}`;
  }

  function hasInputWait(sessionID: string): boolean {
    return (inputWaitsByParent.get(sessionID)?.size ?? 0) > 0;
  }

  function clearInputWaits(sessionID: string): void {
    inputWaitsByParent.delete(sessionID);
  }

  function trackInputWait(event: {
    type: string;
    properties?: { id?: string; requestID?: string; sessionID?: string };
  }): void {
    const sessionID = event.properties?.sessionID;
    if (!sessionID || !options.shouldManageSession(sessionID)) {
      return;
    }

    if (isInputWaitAskEvent(event.type)) {
      const requestID = event.properties?.id;
      const waits =
        inputWaitsByParent.get(sessionID) ?? new Set<string | symbol>();
      if (!requestID) {
        waits.add(IDLESS_INPUT_WAIT);
        inputWaitsByParent.set(sessionID, waits);
        invalidateContinuation(sessionID);
        return;
      }
      const key = inputWaitKey(INPUT_WAIT_ASK_EVENTS[event.type], requestID);
      waits.add(key);
      inputWaitsByParent.set(sessionID, waits);
      invalidateContinuation(sessionID);
      return;
    }

    if (!isInputWaitResolutionEvent(event.type)) return;
    const requestID = event.properties?.requestID;
    if (!requestID) return;
    const key = inputWaitKey(
      INPUT_WAIT_RESOLUTION_EVENTS[event.type],
      requestID,
    );
    const waits = inputWaitsByParent.get(sessionID);
    if (!waits) return;
    waits.delete(key);
    if (waits.size === 0) clearInputWaits(sessionID);
  }

  function isActiveStatus(
    status: Record<string, unknown>,
    sessionID: string,
  ): boolean {
    return Object.hasOwn(status, sessionID);
  }

  async function evaluateContinuation(
    parentSessionID: string,
    sessionToken: symbol,
  ): Promise<void> {
    const evaluationToken = Symbol(parentSessionID);
    const activeEvaluations =
      activeContinuationEvaluations.get(parentSessionID) ?? new Set<symbol>();
    activeEvaluations.add(evaluationToken);
    activeContinuationEvaluations.set(parentSessionID, activeEvaluations);

    if (
      continuationConsumed.has(parentSessionID) ||
      hasInputWait(parentSessionID) ||
      !isCurrentContinuation(parentSessionID, sessionToken, evaluationToken) ||
      options.isFallbackInProgress?.(parentSessionID) ||
      backgroundJobBoard.hasTerminalUnreconciled(parentSessionID) ||
      !sessionSdk?.todo ||
      !sessionSdk.children ||
      !sessionSdk.status ||
      !sessionSdk.promptAsync
    ) {
      activeEvaluations.delete(evaluationToken);
      if (activeEvaluations.size === 0) {
        activeContinuationEvaluations.delete(parentSessionID);
      }
      return;
    }

    try {
      const [todoResponse, childrenResponse, statusResponse] =
        await Promise.all([
          sessionSdk.todo({
            path: { id: parentSessionID },
            throwOnError: true,
          }),
          sessionSdk.children({
            path: { id: parentSessionID },
            throwOnError: true,
          }),
          sessionSdk.status({ throwOnError: true }),
        ]);
      if (
        !Array.isArray(todoResponse.data) ||
        !Array.isArray(childrenResponse.data) ||
        !isObjectRecord(statusResponse.data)
      ) {
        return;
      }
      const todos = todoResponse.data;
      const children = childrenResponse.data;
      const status = statusResponse.data;
      if (
        !todos.every(
          (todo) => isObjectRecord(todo) && typeof todo.status === 'string',
        ) ||
        !children.every(
          (child) => isObjectRecord(child) && typeof child.id === 'string',
        )
      ) {
        return;
      }
      if (
        !todos.some(
          (todo) => todo.status !== 'completed' && todo.status !== 'cancelled',
        )
      ) {
        return;
      }
      const childIDs = children.map((child) => child.id as string);
      if (
        isActiveStatus(status, parentSessionID) ||
        childIDs.some((childID) => isActiveStatus(status, childID))
      ) {
        return;
      }

      // Re-read liveness immediately before queuing work; board state is only
      // authoritative for terminal results observed by this plugin instance.
      const [latestChildrenResponse, latestStatusResponse] = await Promise.all([
        sessionSdk.children({
          path: { id: parentSessionID },
          throwOnError: true,
        }),
        sessionSdk.status({ throwOnError: true }),
      ]);
      if (
        !Array.isArray(latestChildrenResponse.data) ||
        !isObjectRecord(latestStatusResponse.data) ||
        !latestChildrenResponse.data.every(
          (child) => isObjectRecord(child) && typeof child.id === 'string',
        ) ||
        continuationConsumed.has(parentSessionID) ||
        hasInputWait(parentSessionID) ||
        !isCurrentContinuation(
          parentSessionID,
          sessionToken,
          evaluationToken,
        ) ||
        options.isFallbackInProgress?.(parentSessionID) ||
        backgroundJobBoard.hasTerminalUnreconciled(parentSessionID)
      ) {
        return;
      }
      const latestChildIDs = latestChildrenResponse.data.map(
        (child) => child.id as string,
      );
      const latestStatus = latestStatusResponse.data;
      if (
        isActiveStatus(latestStatus, parentSessionID) ||
        latestChildIDs.some((childID) => isActiveStatus(latestStatus, childID))
      ) {
        return;
      }

      if (
        continuationConsumed.has(parentSessionID) ||
        hasInputWait(parentSessionID) ||
        !isCurrentContinuation(
          parentSessionID,
          sessionToken,
          evaluationToken,
        ) ||
        options.isFallbackInProgress?.(parentSessionID) ||
        backgroundJobBoard.hasTerminalUnreconciled(parentSessionID)
      ) {
        return;
      }
      continuationConsumed.add(parentSessionID);
      await sessionSdk.promptAsync({
        path: { id: parentSessionID },
        body: {
          agent: 'orchestrator',
          parts: [createInternalAgentTextPart(CONTINUATION_NUDGE)],
        },
        throwOnError: true,
      });
    } catch (error) {
      log(
        '[task-session-manager] continuation nudge suppressed after SDK error',
        {
          parentSessionID,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      const evaluations = activeContinuationEvaluations.get(parentSessionID);
      evaluations?.delete(evaluationToken);
      if (evaluations?.size === 0) {
        activeContinuationEvaluations.delete(parentSessionID);
      }
    }
  }

  function scheduleIdleReconciliation(parentSessionID: string): void {
    if (
      idleReconcileTimers.has(parentSessionID) ||
      hasInputWait(parentSessionID) ||
      options.isFallbackInProgress?.(parentSessionID)
    ) {
      return;
    }
    const sessionToken = getContinuationSessionToken(parentSessionID);
    const timer = setTimeout(() => {
      idleReconcileTimers.delete(parentSessionID);
      if (!isCurrentContinuation(parentSessionID, sessionToken)) {
        return;
      }
      const hadTerminalUnreconciled =
        backgroundJobBoard.hasTerminalUnreconciled(parentSessionID);
      reconcileInjectedTerminalJobs(parentSessionID);
      if (!hadTerminalUnreconciled) {
        void evaluateContinuation(parentSessionID, sessionToken);
      }
    }, idleReconcileDelayMs).unref?.();
    idleReconcileTimers.set(parentSessionID, timer);
  }

  if (options.coordinator) {
    options.coordinator.onSessionDeleted((sessionId) => {
      clearContinuation(sessionId);
      clearInputWaits(sessionId);
      // During a foreground fallback abort/re-prompt cycle, the session
      // is being torn down and immediately recreated with a fallback model.
      // Dropping the job from the board here would make the orchestrator
      // lose track of the task and report it as cancelled even though the
      // oracle actually completed.
      if (!options.isFallbackInProgress?.(sessionId)) {
        backgroundJobBoard.drop(sessionId);
        backgroundJobBoard.clearParent(sessionId);
      }
      terminalJobsInjectedByParent.delete(sessionId);
      taskContextTracker.clearSession(sessionId);
      taskContextTracker.prune(backgroundJobBoard);
      pendingCallTracker.clearSession(sessionId);
    });
  }

  function updateBackgroundJobFromOutput(
    output: unknown,
  ): BackgroundJobRecord | undefined {
    if (typeof output !== 'string') return undefined;

    const status = parseTaskStatusOutput(output);
    if (!status) return undefined;

    log('[task-session-manager] parsed task output status', {
      taskID: status.taskID,
      state: status.state,
      timedOut: status.timedOut,
      hasResult: Boolean(status.result),
    });

    const existing = backgroundJobBoard.get(status.taskID);
    if (isLateCancelledTaskError(existing, status.state)) {
      log('[task-session-manager] suppressed late cancelled task error', {
        taskID: status.taskID,
        alias: existing?.alias,
        parsedState: status.state,
        boardState: existing?.state,
        terminalState: existing?.terminalState,
        result: status.result,
      });
      return existing;
    }

    const updated = backgroundJobBoard.updateStatus({
      taskID: status.taskID,
      state: status.state,
      timedOut: status.timedOut,
      resultSummary: status.result,
    });
    if (!updated) {
      log('[task-session-manager] ignored status for unknown background job', {
        taskID: status.taskID,
        state: status.state,
      });
      return undefined;
    }

    log('[task-session-manager] background job status updated', {
      taskID: updated.taskID,
      alias: updated.alias,
      parentSessionID: updated.parentSessionID,
      state: updated.state,
      terminalUnreconciled: updated.terminalUnreconciled,
      timedOut: updated.timedOut,
    });

    if (backgroundJobBoard.isTerminalUnreconciled(updated.taskID)) {
      taskContextTracker.pendingManagedTaskIds.delete(updated.taskID);
      backgroundJobBoard.addContext(
        updated.taskID,
        taskContextTracker.contextFilesForPrompt(updated.taskID),
      );
      taskContextTracker.prune(backgroundJobBoard);
    }

    return updated;
  }

  function updateFromInjectedCompletion(
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

    const existing = backgroundJobBoard.get(status.taskID);
    if (isFailed && isLateCancelledTaskError(existing, status.state)) {
      part.text = formatCancelledTaskStatusOutput(
        status.taskID,
        backgroundJobBoard.getResultSummary(status.taskID),
      );
      log('[task-session-manager] normalized late cancelled injected failure', {
        taskID: status.taskID,
        alias: existing?.alias,
        parsedState: status.state,
        boardState: existing?.state,
        terminalState: existing?.terminalState,
        result: status.result,
      });
      rememberProcessedInjectedCompletion(occurrenceId);
      return existing;
    }

    if (isCompleted && status.state !== 'completed') return undefined;
    if (isFailed && status.state !== 'error') return undefined;

    if (processedInjectedCompletions.has(occurrenceId)) return undefined;

    const updated = updateBackgroundJobFromOutput(part.text);
    if (!updated) return undefined;

    log('[task-session-manager] processed injected background completion', {
      taskID: updated.taskID,
      alias: updated.alias,
      parentSessionID: updated.parentSessionID,
      state: updated.state,
      occurrenceId,
    });

    rememberProcessedInjectedCompletion(occurrenceId);
    return updated;
  }

  function rememberProcessedInjectedCompletion(signature: string): void {
    processedInjectedCompletions.add(signature);
    processedInjectedCompletionOrder.push(signature);

    while (
      processedInjectedCompletionOrder.length >
      MAX_PROCESSED_INJECTED_COMPLETIONS
    ) {
      const evicted = processedInjectedCompletionOrder.shift();
      if (!evicted) break;
      processedInjectedCompletions.delete(evicted);
    }
  }

  function isMissingRememberedSessionError(output: string): boolean {
    const firstLine = output.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? '';
    return (
      firstLine.startsWith('[error]') &&
      firstLine.includes('session') &&
      (firstLine.includes('not found') || firstLine.includes('no session'))
    );
  }

  function rememberInjectedTerminalJobs(parentSessionID: string): void {
    const taskIDs = backgroundJobBoard
      .list(parentSessionID)
      .filter((job) => job.terminalUnreconciled)
      .map((job) => job.taskID);
    if (taskIDs.length === 0) return;

    log('[task-session-manager] terminal jobs injected for reconciliation', {
      parentSessionID,
      taskIDs,
    });

    const existing =
      terminalJobsInjectedByParent.get(parentSessionID) ?? new Set<string>();
    for (const taskID of taskIDs) {
      existing.add(taskID);
    }
    terminalJobsInjectedByParent.set(parentSessionID, existing);
  }

  function reconcileInjectedTerminalJobs(parentSessionID: string): void {
    const taskIDs = terminalJobsInjectedByParent.get(parentSessionID);
    if (!taskIDs) return;

    log('[task-session-manager] reconciling injected terminal jobs', {
      parentSessionID,
      taskIDs: [...taskIDs],
    });

    for (const taskID of taskIDs) {
      backgroundJobBoard.markReconciled(taskID);
    }
    terminalJobsInjectedByParent.delete(parentSessionID);
  }

  async function injectBackgroundJobBoard(
    _input: Record<string, never>,
    output: { messages?: unknown },
  ): Promise<void> {
    const messages = Array.isArray(output.messages) ? output.messages : [];

    // Strip previously injected board content: parts attached to real
    // messages (legacy placement) and whole synthetic board messages.
    stripTaggedContent(messages, BACKGROUND_JOB_BOARD_METADATA_KEY);

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!isUserMessageWithParts(message)) continue;
      if (message.info.agent && message.info.agent !== 'orchestrator') return;
      if (
        !message.info.sessionID ||
        !options.shouldManageSession(message.info.sessionID)
      ) {
        return;
      }

      const reminder = backgroundJobBoard.formatForPrompt(
        message.info.sessionID,
      );
      if (!reminder) return;

      const textPart = message.parts.find(
        (part) => part.type === 'text' && typeof part.text === 'string',
      );
      if (!textPart || isInternalInitiatorPart(textPart)) return;

      rememberInjectedTerminalJobs(message.info.sessionID);
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
          metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
        },
      );
      return;
    }
  }

  return {
    observeChatMessage: (input: unknown, output: unknown): void => {
      const inputMessage = isObjectRecord(input) ? input : undefined;
      const outputRecord = isObjectRecord(output) ? output : undefined;
      const outputMessage = isObjectRecord(outputRecord?.message)
        ? outputRecord.message
        : undefined;
      const sessionID =
        typeof outputMessage?.sessionID === 'string'
          ? outputMessage.sessionID
          : typeof inputMessage?.sessionID === 'string'
            ? inputMessage.sessionID
            : undefined;
      const parts = Array.isArray(outputRecord?.parts)
        ? outputRecord.parts
        : inputMessage?.parts;
      if (
        !sessionID ||
        (typeof outputMessage?.role === 'string' &&
          outputMessage.role !== 'user') ||
        !options.shouldManageSession(sessionID) ||
        !Array.isArray(parts) ||
        !parts.some(
          (part) =>
            isObjectRecord(part) &&
            part.synthetic !== true &&
            !isInternalInitiatorPart(part) &&
            ((part.type === 'text' && typeof part.text === 'string') ||
              part.type === 'file' ||
              part.type === 'image'),
        )
      ) {
        return;
      }
      invalidateContinuation(sessionID);
      continuationConsumed.delete(sessionID);
    },

    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      const toolName = input.tool.toLowerCase();
      if (toolName !== 'task') return;
      if (!input.sessionID) return;
      if (!options.shouldManageSession(input.sessionID)) {
        // ponytail: no agent-identity guard here — at tool.execute.before
        // time there's no message to inspect. Only orchestrators call `task`
        // in standard architecture; non-orchestrator false-positives are
        // accepted because leaf agents don't use this tool.
        options.registerSessionAsOrchestrator?.(input.sessionID);
        if (!options.shouldManageSession(input.sessionID)) return;
        log('[task-session-manager] recovered stale orchestrator mapping', {
          sessionID: input.sessionID,
        });
      }
      if (!isObjectRecord(output.args)) return;

      const args = output.args as TaskArgs;
      if (
        typeof args.subagent_type !== 'string' ||
        args.subagent_type.trim() === ''
      ) {
        if (typeof args.task_id === 'string' && args.task_id.trim() !== '') {
          delete args.task_id;
        }
        return;
      }

      const agentType = args.subagent_type.trim();

      const label = deriveTaskSessionLabel({
        description:
          typeof args.description === 'string' ? args.description : undefined,
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        agentType,
      });

      const pendingCall: PendingTaskCall = {
        callId: pendingCallTracker.pendingCallId(input.sessionID, input.callID),
        parentSessionId: input.sessionID,
        agentType,
        label,
      };
      pendingCallTracker.add(pendingCall);
      log(
        '[task-session-manager] tool.execute.before task — pending call created',
        {
          callId: pendingCall.callId,
          parentSessionId: pendingCall.parentSessionId,
          agentType: pendingCall.agentType,
          label: pendingCall.label,
          inputCallID: input.callID,
          inputSessionID: input.sessionID,
        },
      );

      if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
        return;
      }

      const requested = args.task_id.trim();
      const remembered =
        backgroundJobBoard.resolveReusable(
          input.sessionID,
          requested,
          agentType,
        ) ??
        backgroundJobBoard.resolveRecoverable(
          input.sessionID,
          requested,
          agentType,
        );

      if (!remembered) {
        const knownManagedTask = backgroundJobBoard.resolve(
          input.sessionID,
          requested,
        );
        if (knownManagedTask) {
          delete args.task_id;
          return;
        }

        if (RAW_SESSION_ID_PATTERN.test(requested)) {
          pendingCall.resumedTaskId = requested;
          pendingCallTracker.add(pendingCall);
          return;
        }
        delete args.task_id;
        return;
      }

      args.task_id = remembered.taskID;
      taskContextTracker.pendingManagedTaskIds.add(remembered.taskID);
      backgroundJobBoard.markUsed(input.sessionID, remembered.taskID);
      pendingCall.resumedTaskId = remembered.taskID;
      pendingCallTracker.add(pendingCall);
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      if (input.tool.toLowerCase() === 'read') {
        if (input.sessionID) {
          const canTrack =
            taskContextTracker.pendingManagedTaskIds.has(input.sessionID) ||
            backgroundJobBoard.taskIDs().has(input.sessionID);
          if (canTrack) {
            taskContextTracker.addContext(
              input.sessionID,
              extractReadFiles(_ctx.directory, output),
            );
          }
        }
        return;
      }

      if (input.tool.toLowerCase() !== 'task') return;

      const pending = pendingCallTracker.take(input.callID, input.sessionID);
      log('[task-session-manager] tool.execute.after task', {
        callID: input.callID,
        sessionID: input.sessionID,
        hasPending: !!pending,
        outputType: typeof output.output,
        outputPreview:
          typeof output.output === 'string'
            ? output.output.slice(0, 120)
            : undefined,
      });

      if (!pending || typeof output.output !== 'string') return;
      const launch = parseTaskLaunchOutput(output.output);
      if (launch && !launch.result?.match(/Timed out after \d+ms/i)) {
        const record = backgroundJobBoard.registerLaunch({
          taskID: launch.taskID,
          parentSessionID: pending.parentSessionId,
          agent: pending.agentType,
          description: pending.label,
          objective: pending.label,
        });
        log('[task-session-manager] background task launch registered', {
          taskID: record.taskID,
          alias: record.alias,
          parentSessionID: record.parentSessionID,
          agent: record.agent,
          description: record.description,
          state: record.state,
        });
        taskContextTracker.pendingManagedTaskIds.add(launch.taskID);
        backgroundJobBoard.addContext(
          launch.taskID,
          taskContextTracker.contextFilesForPrompt(launch.taskID),
        );
        return;
      }

      normalizeLateCancelledTaskOutput(output);
      const status = parseTaskStatusOutput(output.output);
      if (status) {
        const existing = backgroundJobBoard.get(status.taskID);
        const record =
          existing ??
          backgroundJobBoard.registerLaunch({
            taskID: status.taskID,
            parentSessionID: pending.parentSessionId,
            agent: pending.agentType,
            description: pending.label,
            objective: pending.label,
          });
        const updated = backgroundJobBoard.updateStatus({
          taskID: status.taskID,
          state: status.state,
          timedOut: status.timedOut,
          resultSummary: status.result,
        });
        log('[task-session-manager] foreground task status registered', {
          taskID: status.taskID,
          alias: updated?.alias ?? record.alias,
          parentSessionID: pending.parentSessionId,
          agent: pending.agentType,
          state: updated?.state ?? record.state,
        });
        if (pending.resumedTaskId && pending.resumedTaskId !== status.taskID) {
          backgroundJobBoard.drop(pending.resumedTaskId);
        }
        taskContextTracker.pendingManagedTaskIds.delete(status.taskID);
        backgroundJobBoard.addContext(
          status.taskID,
          taskContextTracker.contextFilesForPrompt(status.taskID),
        );
        taskContextTracker.prune(backgroundJobBoard);
        return;
      }

      const taskId = parseTaskIdFromTaskOutput(output.output);
      if (!taskId) {
        if (
          pending.resumedTaskId &&
          isMissingRememberedSessionError(output.output)
        ) {
          backgroundJobBoard.drop(pending.resumedTaskId);
        }
        return;
      }

      if (pending.resumedTaskId && pending.resumedTaskId !== taskId) {
        backgroundJobBoard.drop(pending.resumedTaskId);
      }

      taskContextTracker.pendingManagedTaskIds.delete(taskId);
      backgroundJobBoard.addContext(
        taskId,
        taskContextTracker.contextFilesForPrompt(taskId),
      );
      taskContextTracker.prune(backgroundJobBoard);
    },

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      for (const [messageIndex, message] of messages.entries()) {
        if (!isUserMessageWithParts(message)) continue;
        if (message.info.agent && message.info.agent !== 'orchestrator') {
          continue;
        }
        if (
          !message.info.sessionID ||
          !options.shouldManageSession(message.info.sessionID)
        ) {
          const sessionID = message.info.sessionID;
          if (!sessionID || message.info.agent !== 'orchestrator') {
            continue;
          }
          options.registerSessionAsOrchestrator?.(sessionID);
          if (!options.shouldManageSession(sessionID)) continue;
        }

        for (const [partIndex, part] of message.parts.entries()) {
          updateFromInjectedCompletion(part, message, messageIndex, partIndex);
        }
      }
    },

    injectBackgroundJobBoard,

    event: async (input: {
      event: {
        type: string;
        properties?: {
          info?: { id?: string; parentID?: string };
          id?: string;
          requestID?: string;
          sessionID?: string;
          status?: { type?: string };
          error?: { name?: string };
        };
      };
    }): Promise<void> => {
      trackInputWait(input.event);

      if (input.event.type === 'session.created') {
        const info = input.event.properties?.info;
        log('[task-session-manager] session.created observed', {
          sessionID: info?.id,
          parentSessionID: info?.parentID,
          managesParent: info?.parentID
            ? options.shouldManageSession(info.parentID)
            : false,
        });
        if (
          info?.id &&
          info.parentID &&
          options.shouldManageSession(info.parentID)
        ) {
          taskContextTracker.pendingManagedTaskIds.add(info.id);
          // Early board registration: if the parent tool call is cancelled
          // before tool.execute.after (e.g. foreground fallback abort), the
          // after-hook never fires and the job is never tracked — idle then
          // reports runningJobForSession:false and the orchestrator sees
          // "Task cancelled" while the child is still working (#765).
          // Peek (don't take) so tool.execute.after can still re-register.
          const pending = pendingCallTracker.peekByParent(info.parentID);
          if (
            pending &&
            !pending.resumedTaskId &&
            !backgroundJobBoard.get(info.id)
          ) {
            const record = backgroundJobBoard.registerLaunch({
              taskID: info.id,
              parentSessionID: pending.parentSessionId,
              agent: pending.agentType,
              description: pending.label,
              objective: pending.label,
            });
            log(
              '[task-session-manager] early board registration from session.created',
              {
                taskID: record.taskID,
                alias: record.alias,
                parentSessionID: record.parentSessionID,
                agent: record.agent,
              },
            );
          }
        }
        return;
      }

      if (input.event.type === 'server.instance.disposed') {
        const continuationSessionIDs = new Set([
          ...idleReconcileTimers.keys(),
          ...continuationSessionTokens.keys(),
          ...activeContinuationEvaluations.keys(),
          ...continuationConsumed,
          ...inputWaitsByParent.keys(),
        ]);
        for (const sessionID of continuationSessionIDs) {
          clearContinuation(sessionID);
          clearInputWaits(sessionID);
        }
        return;
      }

      if (
        input.event.type === 'session.idle' ||
        (input.event.type === 'session.status' &&
          (input.event.properties as { status?: { type?: string } } | undefined)
            ?.status?.type === 'idle')
      ) {
        const sessionId =
          input.event.properties?.info?.id || input.event.properties?.sessionID;
        const job = sessionId ? backgroundJobBoard.get(sessionId) : undefined;
        log('[task-session-manager] idle/status idle observed', {
          sessionID: sessionId,
          managesSession: sessionId
            ? options.shouldManageSession(sessionId)
            : false,
          terminalJobsPending: sessionId
            ? (terminalJobsInjectedByParent.get(sessionId)?.size ?? 0)
            : 0,
          runningJobForSession: job?.state === 'running' || false,
        });
        if (sessionId && options.shouldManageSession(sessionId)) {
          scheduleIdleReconciliation(sessionId);
        }

        // Fallback: for background child sessions that go idle without
        // an injected completion, reconcile the board entry since the
        // session being idle is itself the completion signal.
        // Guard: skip when a foreground-fallback abort/re-prompt is in
        // flight for this session — the idle is transient, not a real
        // completion.
        if (
          job &&
          sessionId &&
          job.state === 'running' &&
          !options.isFallbackInProgress?.(sessionId)
        ) {
          log('[task-session-manager] reconciled running job from idle', {
            sessionID: sessionId,
            alias: job.alias,
            parentSessionID: job.parentSessionID,
          });
          backgroundJobBoard.updateStatus({
            taskID: sessionId,
            state: 'completed',
            resultSummary:
              'Background task completed (reconciled from idle event)',
          });
          backgroundJobBoard.markReconciled(sessionId);
          taskContextTracker.pendingManagedTaskIds.delete(sessionId);
          backgroundJobBoard.addContext(
            sessionId,
            taskContextTracker.contextFilesForPrompt(sessionId),
          );
          taskContextTracker.prune(backgroundJobBoard);
        }
        return;
      }

      if (input.event.type === 'session.error') {
        const sessionId =
          input.event.properties?.info?.id || input.event.properties?.sessionID;
        if (sessionId) {
          invalidateContinuation(sessionId);
        }
        if (sessionId && options.shouldManageSession(sessionId)) {
          // Only clear injected terminal jobs for fatal errors.
          // Rate-limit errors are recovered by ForegroundFallbackManager
          // (abort + reprompt with fallback model); clearing the injected
          // job state here would make the orchestrator lose track of
          // completed background tasks and unable to dispatch follow-ups.
          const props = input.event.properties as
            | { error?: unknown }
            | undefined;
          if (!props?.error || !isFailoverError(props.error)) {
            terminalJobsInjectedByParent.delete(sessionId);
            // Record non-retryable errors on the job board so the
            // orchestrator sees the failure instead of a false completion.
            const job = backgroundJobBoard.get(sessionId);
            if (job && job.state === 'running') {
              backgroundJobBoard.updateStatus({
                taskID: sessionId,
                state: 'error',
                resultSummary:
                  (props?.error as { message?: string } | undefined)?.message ??
                  'Session error',
              });
            }
          }
        }

        return;
      }

      if (input.event.type === 'session.status') {
        const sessionId =
          input.event.properties?.info?.id || input.event.properties?.sessionID;
        const statusType = (
          input.event.properties as { status?: { type?: string } } | undefined
        )?.status?.type;
        if (sessionId) invalidateContinuation(sessionId);
        if (statusType !== 'busy') {
          return;
        }
        const before = sessionId
          ? backgroundJobBoard.get(sessionId)
          : undefined;
        const updated = sessionId
          ? backgroundJobBoard.markRunningFromLiveSession(sessionId)
          : undefined;
        if (before?.cancellationRequested) {
          log('[task-session-manager] busy observed after cancel request', {
            sessionID: sessionId,
            previousState: before.state,
            previousTerminalState: before.terminalState,
            terminalUnreconciled: before.terminalUnreconciled,
            resultSummary: before.resultSummary,
          });
        }
        log('[task-session-manager] busy/status busy observed', {
          sessionID: sessionId,
          managesSession: sessionId
            ? options.shouldManageSession(sessionId)
            : false,
          previousState: before?.state,
          previousTerminalState: before?.terminalState,
          previousCancellationRequested: before?.cancellationRequested ?? false,
          previousLastLiveBusyAt: before?.lastLiveBusyAt,
          updatedState: updated?.state,
          updatedCancellationRequested: updated?.cancellationRequested ?? false,
          updatedLastLiveBusyAt: updated?.lastLiveBusyAt,
        });
        return;
      }

      if (input.event.type !== 'session.deleted') return;
      const sessionId =
        input.event.properties?.info?.id || input.event.properties?.sessionID;
      if (!sessionId) return;

      clearContinuation(sessionId);
      clearInputWaits(sessionId);

      log('[task-session-manager] session.deleted observed', {
        sessionID: sessionId,
      });
    },
  };

  function normalizeLateCancelledTaskOutput(output: {
    output: unknown;
    metadata?: unknown;
  }): void {
    if (typeof output.output !== 'string') return;
    const status = parseTaskStatusOutput(output.output);
    if (!status) return;
    const existing = backgroundJobBoard.get(status.taskID);
    if (!isLateCancelledTaskError(existing, status.state)) return;
    log('[task-session-manager] normalized late cancelled task output', {
      taskID: status.taskID,
      alias: existing?.alias,
      state: existing?.state,
      terminalState: existing?.terminalState,
      result: status.result,
    });
    output.output = formatCancelledTaskStatusOutput(
      status.taskID,
      backgroundJobBoard.getResultSummary(status.taskID),
    );
    if (isObjectRecord(output) && isObjectRecord(output.metadata)) {
      output.metadata.state = 'cancelled';
    }
  }
}

function isLateCancelledTaskError(
  job: BackgroundJobRecord | undefined,
  state: string,
): boolean {
  if (state !== 'error') return false;
  if (!job?.cancellationRequested) return false;
  return job.state === 'cancelled' || job.terminalState === 'cancelled';
}

function formatCancelledTaskStatusOutput(
  taskID: string,
  summary = 'cancelled',
): string {
  return [
    `task_id: ${taskID}`,
    'state: cancelled',
    '',
    '<task_error>',
    summary,
    '</task_error>',
  ].join('\n');
}
