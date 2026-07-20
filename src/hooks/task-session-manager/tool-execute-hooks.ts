/**
 * Tool execute hooks for task session manager.
 *
 * Handles `tool.execute.before` (task tool: pending call creation,
 * reusable/recoverable task_id resolution) and `tool.execute.after`
 * (read context tracking, task launch registration/update from output).
 */
import type { BackgroundJobStore, ContextFile } from '../../utils';
import {
  deriveTaskSessionLabel,
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import { isMissingRememberedSessionError } from './board-injection';
import type { PendingTaskCall } from './pending-call-tracker';
import { normalizeLateCancelledTaskOutput } from './status-utils';
import { extractReadFiles } from './task-context-tracker';

const RAW_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;

interface TaskArgs {
  description?: unknown;
  prompt?: unknown;
  subagent_type?: unknown;
  task_id?: unknown;
}

export async function handleToolExecuteBefore(
  input: { tool: string; sessionID?: string; callID?: string },
  output: { args?: unknown },
  deps: {
    shouldManageSession: (sessionID: string) => boolean;
    registerSessionAsOrchestrator?: (sessionID: string) => void;
    backgroundJobBoard: BackgroundJobStore;
    pendingCallTracker: {
      add(call: PendingTaskCall): void;
      pendingCallId(sessionID?: string, callID?: string): string;
    };
    taskContextTracker: { pendingManagedTaskIds: Set<string> };
  },
): Promise<void> {
  const toolName = input.tool.toLowerCase();
  if (toolName !== 'task') return;
  if (!input.sessionID) return;
  if (!deps.shouldManageSession(input.sessionID)) {
    // ponytail: no agent-identity guard here — at tool.execute.before
    // time there's no message to inspect. Only orchestrators call `task`
    // in standard architecture; non-orchestrator false-positives are
    // accepted because leaf agents don't use this tool.
    deps.registerSessionAsOrchestrator?.(input.sessionID);
    if (!deps.shouldManageSession(input.sessionID)) return;
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
    callId: deps.pendingCallTracker.pendingCallId(
      input.sessionID,
      input.callID,
    ),
    parentSessionId: input.sessionID,
    agentType,
    label,
  };
  deps.pendingCallTracker.add(pendingCall);
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
    deps.backgroundJobBoard.resolveReusable(
      input.sessionID,
      requested,
      agentType,
    ) ??
    deps.backgroundJobBoard.resolveRecoverable(
      input.sessionID,
      requested,
      agentType,
    );

  if (!remembered) {
    const knownManagedTask = deps.backgroundJobBoard.resolve(
      input.sessionID,
      requested,
    );
    if (knownManagedTask) {
      delete args.task_id;
      return;
    }

    if (RAW_SESSION_ID_PATTERN.test(requested)) {
      pendingCall.resumedTaskId = requested;
      deps.pendingCallTracker.add(pendingCall);
      return;
    }
    delete args.task_id;
    return;
  }

  args.task_id = remembered.taskID;
  deps.taskContextTracker.pendingManagedTaskIds.add(remembered.taskID);
  deps.backgroundJobBoard.markUsed(input.sessionID, remembered.taskID);
  pendingCall.resumedTaskId = remembered.taskID;
  deps.pendingCallTracker.add(pendingCall);
}

export async function handleToolExecuteAfter(
  input: { tool: string; sessionID?: string; callID?: string },
  output: { output: unknown; metadata?: unknown },
  deps: {
    directory: string;
    backgroundJobBoard: BackgroundJobStore;
    pendingCallTracker: {
      take(callID?: string, sessionID?: string): PendingTaskCall | undefined;
    };
    taskContextTracker: {
      pendingManagedTaskIds: Set<string>;
      addContext(taskId: string, files: ContextFile[]): void;
      contextFilesForPrompt(taskId: string): ContextFile[];
      prune(board: { taskIDs(): Set<string> }): void;
    };
  },
): Promise<void> {
  if (input.tool.toLowerCase() === 'read') {
    if (input.sessionID) {
      const canTrack =
        deps.taskContextTracker.pendingManagedTaskIds.has(input.sessionID) ||
        deps.backgroundJobBoard.taskIDs().has(input.sessionID);
      if (canTrack) {
        deps.taskContextTracker.addContext(
          input.sessionID,
          extractReadFiles(deps.directory, output),
        );
      }
    }
    return;
  }

  if (input.tool.toLowerCase() !== 'task') return;

  const pending = deps.pendingCallTracker.take(input.callID, input.sessionID);
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
    const record = deps.backgroundJobBoard.registerLaunch({
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
    deps.taskContextTracker.pendingManagedTaskIds.add(launch.taskID);
    deps.backgroundJobBoard.addContext(
      launch.taskID,
      deps.taskContextTracker.contextFilesForPrompt(launch.taskID),
    );
    return;
  }

  normalizeLateCancelledTaskOutput(output, deps.backgroundJobBoard);
  const status = parseTaskStatusOutput(output.output);
  if (status) {
    const existing = deps.backgroundJobBoard.get(status.taskID);
    const record =
      existing ??
      deps.backgroundJobBoard.registerLaunch({
        taskID: status.taskID,
        parentSessionID: pending.parentSessionId,
        agent: pending.agentType,
        description: pending.label,
        objective: pending.label,
      });
    const updated = deps.backgroundJobBoard.updateStatus({
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
      deps.backgroundJobBoard.drop(pending.resumedTaskId);
    }
    deps.taskContextTracker.pendingManagedTaskIds.delete(status.taskID);
    deps.backgroundJobBoard.addContext(
      status.taskID,
      deps.taskContextTracker.contextFilesForPrompt(status.taskID),
    );
    deps.taskContextTracker.prune(deps.backgroundJobBoard);
    return;
  }

  const taskId = parseTaskIdFromTaskOutput(output.output);
  if (!taskId) {
    if (
      pending.resumedTaskId &&
      isMissingRememberedSessionError(output.output)
    ) {
      deps.backgroundJobBoard.drop(pending.resumedTaskId);
    }
    return;
  }

  if (pending.resumedTaskId && pending.resumedTaskId !== taskId) {
    deps.backgroundJobBoard.drop(pending.resumedTaskId);
  }

  deps.taskContextTracker.pendingManagedTaskIds.delete(taskId);
  deps.backgroundJobBoard.addContext(
    taskId,
    deps.taskContextTracker.contextFilesForPrompt(taskId),
  );
  deps.taskContextTracker.prune(deps.backgroundJobBoard);
}
