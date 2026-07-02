import type { PluginInput } from '@opencode-ai/plugin';
import {
  BackgroundJobBoard,
  type BackgroundJobRecord,
  deriveTaskSessionLabel,
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import type { MessagePart, MessageWithParts } from '../types';
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

const BACKGROUND_JOB_BOARD_SENTINEL = 'SENTINEL: background-job-board-v2';
const BACKGROUND_COMPLETION_COMPLETED = /^Background task completed: /;
const BACKGROUND_COMPLETION_FAILED = /^Background task failed: /;
const MAX_PROCESSED_INJECTED_COMPLETIONS = 500;
const RAW_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;

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
    backgroundJobBoard?: BackgroundJobBoard;
    shouldManageSession: (sessionID: string) => boolean;
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
    if (!status) return undefined;
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

  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      const toolName = input.tool.toLowerCase();
      if (toolName !== 'task') return;
      if (!input.sessionID || !options.shouldManageSession(input.sessionID)) {
        return;
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

      if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
        return;
      }

      const requested = args.task_id.trim();
      const remembered = backgroundJobBoard.resolveReusable(
        input.sessionID,
        requested,
        agentType,
      );

      if (!remembered) {
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
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      for (const [messageIndex, message] of output.messages.entries()) {
        if (message.info.role !== 'user') continue;
        if (message.info.agent && message.info.agent !== 'orchestrator') {
          continue;
        }
        if (
          !message.info.sessionID ||
          !options.shouldManageSession(message.info.sessionID)
        ) {
          continue;
        }

        for (const [partIndex, part] of message.parts.entries()) {
          updateFromInjectedCompletion(part, message, messageIndex, partIndex);
        }
      }

      for (let i = output.messages.length - 1; i >= 0; i -= 1) {
        const message = output.messages[i];
        if (message.info.role !== 'user') continue;
        if (message.info.agent && message.info.agent !== 'orchestrator') return;
        if (
          !message.info.sessionID ||
          !options.shouldManageSession(message.info.sessionID)
        ) {
          return;
        }

        const reminders = [
          backgroundJobBoard.formatForPrompt(message.info.sessionID),
        ].filter((item): item is string => Boolean(item));
        if (reminders.length === 0) return;

        const textPart = message.parts.find(
          (part) => part.type === 'text' && typeof part.text === 'string',
        );
        if (!textPart) return;
        if (textPart.text?.includes(SLIM_INTERNAL_INITIATOR_MARKER)) return;
        if (textPart.text?.includes(BACKGROUND_JOB_BOARD_SENTINEL)) return;

        rememberInjectedTerminalJobs(message.info.sessionID);
        textPart.text = [textPart.text ?? '', '', reminders.join('\n\n')].join(
          '\n',
        );
        return;
      }
    },

    event: async (input: {
      event: {
        type: string;
        properties?: {
          info?: { id?: string; parentID?: string };
          sessionID?: string;
          status?: { type?: string };
          error?: { name?: string };
        };
      };
    }): Promise<void> => {
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
          input.event.properties?.info?.id ?? input.event.properties?.sessionID;
        log('[task-session-manager] idle/status idle observed', {
          sessionID: sessionId,
          managesSession: sessionId
            ? options.shouldManageSession(sessionId)
            : false,
          terminalJobsPending: sessionId
            ? (terminalJobsInjectedByParent.get(sessionId)?.size ?? 0)
            : 0,
        });
        if (sessionId && options.shouldManageSession(sessionId)) {
          reconcileInjectedTerminalJobs(sessionId);
        }
        return;
      }

      if (input.event.type === 'session.error') {
        const sessionId =
          input.event.properties?.info?.id ?? input.event.properties?.sessionID;
        if (sessionId && options.shouldManageSession(sessionId)) {
          terminalJobsInjectedByParent.delete(sessionId);
        }

        return;
      }

      if (
        input.event.type === 'session.status' &&
        (input.event.properties as { status?: { type?: string } } | undefined)
          ?.status?.type === 'busy'
      ) {
        const sessionId =
          input.event.properties?.info?.id ?? input.event.properties?.sessionID;
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
        input.event.properties?.info?.id ?? input.event.properties?.sessionID;
      if (!sessionId) return;

      log(
        '[task-session-manager] session.deleted observed; clearing job state',
        {
          sessionID: sessionId,
          deletedJob: (() => {
            const record = backgroundJobBoard.get(sessionId);
            return record
              ? {
                  state: record.state,
                  parentSessionID: record.parentSessionID,
                  alias: record.alias,
                }
              : undefined;
          })(),
          childJobCount: backgroundJobBoard.list(sessionId).length,
          managesSession: options.shouldManageSession(sessionId),
        },
      );

      backgroundJobBoard.drop(sessionId);
      backgroundJobBoard.clearParent(sessionId);
      terminalJobsInjectedByParent.delete(sessionId);
      taskContextTracker.clearSession(sessionId);
      taskContextTracker.prune(backgroundJobBoard);
      pendingCallTracker.clearSession(sessionId);
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
