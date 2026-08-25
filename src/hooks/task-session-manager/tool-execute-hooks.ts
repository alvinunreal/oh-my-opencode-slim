/**
 * Tool execute hooks for task session manager.
 *
 * Handles `tool.execute.before` (task tool: pending call creation,
 * reusable/recoverable task_id resolution) and `tool.execute.after`
 * (read context tracking, task launch registration/update from output).
 */
import type {
  BackgroundJobStore,
  BackgroundJobSupervisor,
  ContextFile,
} from '../../utils';
import {
  deriveFullObjective,
  deriveTaskSessionLabel,
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import { SESSION_ID_PATTERN } from '../../utils/session';
import { isMissingRememberedSessionError } from './board-injection';
import type { PendingTaskCall } from './pending-call-tracker';
import { normalizeLateCancelledTaskOutput } from './status-utils';
import { extractReadFiles } from './task-context-tracker';

interface TaskArgs {
  description?: unknown;
  prompt?: unknown;
  subagent_type?: unknown;
  task_id?: unknown;
  background?: unknown;
}

const earlyRegistrationGenerations = new WeakMap<PendingTaskCall, number>();
function normalizeObjectiveKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * session.created writes earlyRegisteredTaskID through the pending-call
 * object. Capture the generation at that boundary so a delayed native result
 * cannot reuse the current record after a same-ID relaunch.
 */
function installEarlyRegistrationGenerationFence(
  pending: PendingTaskCall,
  backgroundJobBoard: BackgroundJobStore,
): void {
  let earlyRegisteredTaskID = pending.earlyRegisteredTaskID;
  Object.defineProperty(pending, 'earlyRegisteredTaskID', {
    configurable: true,
    enumerable: true,
    get: () => earlyRegisteredTaskID,
    set: (taskID: string | undefined) => {
      earlyRegisteredTaskID = taskID;
      if (!taskID) return;
      const generation = backgroundJobBoard.get(taskID)?.generation;
      if (generation !== undefined) {
        earlyRegistrationGenerations.set(pending, generation);
      }
    },
  });
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
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    getLifecycleEpoch?: () => number;
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
  const background = args.background === true;

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
    background,
    lifecycleEpoch: deps.getLifecycleEpoch?.() ?? 0,
  };
  pendingCall.fullObjective = deriveFullObjective({
    description:
      typeof args.description === 'string' ? args.description : undefined,
    prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
  });
  installEarlyRegistrationGenerationFence(pendingCall, deps.backgroundJobBoard);
  if (typeof args.task_id === 'string' && args.task_id.trim() !== '') {
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
      if (knownManagedTask?.state === 'running') {
        throw new Error(
          `Task ${requested} is still running and cannot be resumed or amended with task(). Do not spawn or cancel a duplicate for an additive request. Wait for its terminal result, then resume the session after that terminal notification is acknowledged if follow-up work is still needed.`,
        );
      }

      if (knownManagedTask) {
        delete args.task_id;
      } else if (SESSION_ID_PATTERN.test(requested)) {
        pendingCall.resumedTaskId = requested;
      } else {
        delete args.task_id;
      }
    } else {
      const relaunchLease = deps.backgroundJobBoard.acquireRelaunchLease(
        remembered.taskID,
        remembered.generation,
      );
      if (!relaunchLease) {
        throw new Error(
          `Task ${requested} cannot be resumed safely: its current generation is already owned by another lifecycle operation. Do not launch a duplicate with the same task_id.`,
        );
      }
      args.task_id = remembered.taskID;
      deps.taskContextTracker.pendingManagedTaskIds.add(remembered.taskID);
      deps.backgroundJobBoard.markUsed(input.sessionID, remembered.taskID);
      pendingCall.resumedTaskId = remembered.taskID;
      pendingCall.relaunchLease = relaunchLease;
    }
  }

  // New spawns only: block re-dispatch of an objective already owned by an
  // unreconciled terminal job from this parent (self-reinforcing dispatch
  // loop, #1070). The full objective text is compared, not the 48-char display
  // label, so long exact duplicates match while distinct objectives that only
  // share a truncated prefix stay unaffected.
  // Escape hatch: task_result retrieval after completion updates lastUsedAt
  // beyond completedAt, marking the result as consumed and authorizing retry.
  if (!pendingCall.resumedTaskId) {
    const objectiveKey = normalizeObjectiveKey(
      pendingCall.fullObjective ?? label,
    );
    const duplicate = deps.backgroundJobBoard
      .list(input.sessionID)
      .find(
        (job) =>
          job.agent === agentType &&
          job.terminalUnreconciled &&
          !(
            job.completedAt !== undefined && job.lastUsedAt > job.completedAt
          ) &&
          normalizeObjectiveKey(job.objective || job.description) ===
            objectiveKey,
      );
    if (duplicate) {
      throw new Error(
        `A background task with the same objective already finished and its result is awaiting acknowledgment: ${duplicate.alias} / ${duplicate.taskID}. Call task_result with task_id "${duplicate.taskID}" to retrieve it instead of spawning a duplicate. If the retrieved result is insufficient, retry the spawn after retrieval — retrieval authorizes the retry.`,
      );
    }
  }

  try {
    deps.pendingCallTracker.add(pendingCall);
  } catch (error) {
    if (pendingCall.relaunchLease) {
      deps.backgroundJobBoard.releaseLease(pendingCall.relaunchLease);
    }
    throw error;
  }
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
}

export async function handleToolExecuteAfter(
  input: { tool: string; sessionID?: string; callID?: string },
  output: { output: unknown; metadata?: unknown },
  deps: {
    directory: string;
    backgroundJobBoard: BackgroundJobStore;
    pendingCallTracker: {
      take(callID?: string, sessionID?: string): PendingTaskCall | undefined;
      release?(call: PendingTaskCall): void;
    };
    taskContextTracker: {
      pendingManagedTaskIds: Set<string>;
      addContext(taskId: string, files: ContextFile[]): void;
      contextFilesForPrompt(taskId: string): ContextFile[];
      prune(board: { taskIDs(): Set<string> }): void;
    };
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    /** Record direct task cleanup even when the store is a thin facade. */
    recordLifecycleSuppression?: (taskID: string) => void;
    /** Clear a deletion guard when a new native task output proves a run exists. */
    clearRehydrateTombstone?: (taskID: string) => void;
    isStaleDeletedTaskOutput?: (
      taskID: string,
      lifecycleEpoch: number,
    ) => boolean;
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

  const exactCallID =
    typeof input.callID === 'string' && input.callID.trim() !== ''
      ? input.callID
      : undefined;
  const pending = deps.pendingCallTracker.take(
    exactCallID,
    exactCallID ? undefined : input.sessionID,
  );
  const exactCallConfirmed =
    exactCallID !== undefined && pending?.callId === exactCallID;
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

  if (!pending) return;

  try {
    if (typeof output.output !== 'string') return;
    if (pending.earlyRegistrationRejected) {
      log(
        '[task-session-manager] ignored task output after fenced early registration',
        { callID: pending.callId },
      );
      return;
    }

    const launch = parseTaskLaunchOutput(output.output);
    if (launch && !launch.result?.match(/Timed out after \d+ms/i)) {
      const record = registerTaskOutputLaunch(
        launch.taskID,
        pending,
        exactCallConfirmed,
        deps,
      );
      if (!record) return;
      deps.clearRehydrateTombstone?.(launch.taskID);
      if (exactCallConfirmed) deps.backgroundJobSupervisor?.onLaunch(record);
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

    const status = parseTaskStatusOutput(output.output);
    if (status) {
      const record = registerTaskOutputLaunch(
        status.taskID,
        pending,
        exactCallConfirmed,
        deps,
      );
      if (!record) return;
      deps.clearRehydrateTombstone?.(status.taskID);
      normalizeLateCancelledTaskOutput(output, deps.backgroundJobBoard);
      if (exactCallConfirmed) deps.backgroundJobSupervisor?.onLaunch(record);
      const updated = deps.backgroundJobBoard.updateStatus({
        taskID: status.taskID,
        state: status.state,
        expectedGeneration: record.generation,
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
        deps.recordLifecycleSuppression?.(pending.resumedTaskId);
        deps.backgroundJobBoard.drop(pending.resumedTaskId);
        deps.backgroundJobSupervisor?.drop(pending.resumedTaskId);
      }
      return;
    }

    if (pending.resumedTaskId && pending.resumedTaskId !== taskId) {
      log(
        '[task-session-manager] ignored task output with mismatched resumed task ID',
        {
          expectedTaskID: pending.resumedTaskId,
          observedTaskID: taskId,
          callID: pending.callId,
        },
      );
      return;
    }

    deps.taskContextTracker.pendingManagedTaskIds.delete(taskId);
    deps.backgroundJobBoard.addContext(
      taskId,
      deps.taskContextTracker.contextFilesForPrompt(taskId),
    );
    deps.taskContextTracker.prune(deps.backgroundJobBoard);
  } finally {
    deps.pendingCallTracker.release?.(pending);
    if (pending.relaunchLease) {
      deps.backgroundJobBoard.releaseLease(pending.relaunchLease);
    }
  }
}

function registerTaskOutputLaunch(
  taskID: string,
  pending: PendingTaskCall,
  exactCallConfirmed: boolean,
  deps: {
    backgroundJobBoard: BackgroundJobStore;
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    isStaleDeletedTaskOutput?: (
      taskID: string,
      lifecycleEpoch: number,
    ) => boolean;
  },
): ReturnType<BackgroundJobStore['get']> {
  if (deps.isStaleDeletedTaskOutput?.(taskID, pending.lifecycleEpoch)) {
    log('[task-session-manager] ignored stale task output after deletion', {
      taskID,
      callID: pending.callId,
      lifecycleEpoch: pending.lifecycleEpoch,
    });
    return undefined;
  }

  const resumed = pending.resumedTaskId !== undefined;
  if (resumed && pending.resumedTaskId !== taskID) return undefined;

  const existing = deps.backgroundJobBoard.get(taskID);
  const earlyRegistrationGeneration = earlyRegistrationGenerations.get(pending);
  if (
    pending.earlyRegisteredTaskID === taskID &&
    earlyRegistrationGeneration !== undefined &&
    existing?.generation !== earlyRegistrationGeneration
  ) {
    log('[task-session-manager] ignored stale native task output', {
      taskID,
      callID: pending.callId,
      registeredGeneration: earlyRegistrationGeneration,
      currentGeneration: existing?.generation,
    });
    return undefined;
  }
  if (resumed && pending.relaunchLease === undefined) {
    log(
      '[task-session-manager] refused resumed task output without relaunch lease',
      { taskID, callID: pending.callId },
    );
    return undefined;
  }
  if (!resumed && existing && pending.earlyRegistrationRejected) {
    log(
      '[task-session-manager] refused task output that collided with an existing task ID',
      { taskID, callID: pending.callId },
    );
    return undefined;
  }
  if (pending.earlyRegisteredTaskID && !existing) return undefined;

  try {
    return deps.backgroundJobBoard.registerLaunch({
      taskID,
      parentSessionID: pending.parentSessionId,
      agent: pending.agentType,
      description: pending.label,
      objective: pending.fullObjective ?? pending.label,
      background: exactCallConfirmed && pending.background,
      preserveRun:
        pending.earlyRegisteredTaskID === taskID ||
        pending.resumedTaskId === undefined,
      ...(pending.relaunchLease
        ? { relaunchLease: pending.relaunchLease }
        : {}),
    });
  } catch (error) {
    log('[task-session-manager] refused task output launch registration', {
      taskID,
      callID: pending.callId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
