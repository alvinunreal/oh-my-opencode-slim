import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobLease } from '../utils/background-job-board';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { responseError, stringifyError } from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { delay } from '../utils/polling';
import {
  OperationTimeoutError,
  SESSION_ID_PATTERN,
  withTimeout,
} from '../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import { isHostTerminalOutcome } from '../utils/task';

const z = tool.schema;

export interface TaskControlToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  shouldManageSession: (sessionID: string) => boolean;
  abortTimeoutMs?: number;
  verifyAbortMs?: number;
  abortRetryIntervalMs?: number;
  stableStoppedMs?: number;
}

interface CapturedExecution {
  taskID: string;
  generation: number;
}

export class SessionStillRunningError extends Error {}

class LeaseOwnershipLostError extends Error {}

class LeaseOperationTimeoutError extends Error {
  constructor(
    message: string,
    readonly pending: boolean,
  ) {
    super(message);
    this.name = 'LeaseOperationTimeoutError';
  }
}

export function createCancelTaskTool(
  options: TaskControlToolOptions,
): Record<'task_cancel', ToolDefinition> {
  const task_cancel = tool({
    description: `Cancel a tracked background specialist task without deleting its session.

Use only for obsolete, wrong, conflicting, or user-requested cancellation. The retained session can be revived after the lifecycle lane acknowledges its terminal state.`,
    args: {
      task_id: z
        .string()
        .describe('Tracked background task ID or Background Job Board alias'),
      reason: z.string().optional().describe('Short cancellation reason'),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertOrchestrator(
        options,
        toolContext,
        'task_cancel',
      );
      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_cancel requires task_id');

      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!job) {
        return unknownTaskOutput(
          requested,
          await untrackedTaskReason(options, parentSessionID, requested),
        );
      }

      const execution = {
        taskID: job.taskID,
        generation: job.generation,
      };
      if (job.state !== 'running') {
        return staleCancellationOutput(
          options,
          execution,
          `task is ${job.state}, not running`,
        );
      }

      try {
        await cancelTrackedExecution(options, execution, args.reason);
      } catch (error) {
        const current = options.backgroundJobBoard.get(execution.taskID);
        const message = error instanceof Error ? error.message : String(error);
        return [
          `task_id: ${execution.taskID}`,
          `state: ${current?.state ?? 'unknown'}`,
          '',
          '<task_error>',
          message,
          '</task_error>',
        ].join('\n');
      }

      const state = options.backgroundJobBoard.getState(execution.taskID);
      return [
        `task_id: ${execution.taskID}`,
        `state: ${state ?? 'cancelled'}`,
        '',
        '<task_error>',
        options.backgroundJobBoard.getResultSummary(execution.taskID) ??
          'cancelled',
        '</task_error>',
      ].join('\n');
    },
  });

  return { task_cancel };
}

/**
 * Abort one captured generation and prove that its retained host session is
 * quiescent. This is shared by task_cancel and task_revive; neither operation
 * ever deletes the session.
 */
export async function cancelTrackedExecution(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  reason?: string,
): Promise<void> {
  const lease = options.backgroundJobBoard.acquireCancellationLease(
    execution.taskID,
    execution.generation,
  );
  if (!lease) {
    throw new Error(
      `stale/uncertain cancellation: cancellation lease unavailable for ${execution.taskID}`,
    );
  }

  let keepLeaseUntilSettled = false;
  try {
    await abortAndVerifySession(options, execution, lease);
    assertCapturedExecution(options.backgroundJobBoard, execution);
    const marked = options.backgroundJobBoard.markCancelled(
      execution.taskID,
      reason,
      Date.now(),
      {
        force: true,
        expectedGeneration: execution.generation,
        cancellationLease: lease,
      },
    );
    if (!isCapturedExecution(marked, execution)) {
      throw new Error(
        `stale/uncertain cancellation: ${execution.taskID} generation changed`,
      );
    }
  } catch (error) {
    keepLeaseUntilSettled =
      error instanceof LeaseOperationTimeoutError && error.pending;
    const message = error instanceof Error ? error.message : String(error);
    options.backgroundJobBoard.markStatusUncertain(
      execution.taskID,
      message,
      execution.generation,
    );
    throw error;
  } finally {
    if (!keepLeaseUntilSettled) {
      options.backgroundJobBoard.releaseLease(lease);
    }
  }
}

async function abortAndVerifySession(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  lease: BackgroundJobLease,
): Promise<void> {
  assertLease(options.backgroundJobBoard, lease, execution);
  const taskID = execution.taskID;
  const abortStartedAt = Date.now();
  let response: unknown;
  try {
    response = await awaitLeaseOperation(
      options.backgroundJobBoard,
      lease,
      () => getClient(options.input).session.abort({ path: { id: taskID } }),
      options.abortTimeoutMs ?? 10_000,
      `Session abort timed out after ${options.abortTimeoutMs ?? 10_000}ms`,
    );
  } catch (error) {
    assertLease(options.backgroundJobBoard, lease, execution);
    throw error;
  }
  assertLease(options.backgroundJobBoard, lease, execution);
  const error = responseError(response);
  if (error !== undefined) throw new Error(stringifyError(error));
  if (operationBoolean(response) === false) {
    throw new Error(`Session abort was not confirmed: ${taskID}`);
  }

  await verifyQuiescentSession(options, execution, lease, abortStartedAt);
}

async function verifyQuiescentSession(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  lease: BackgroundJobLease,
  abortStartedAt: number,
): Promise<void> {
  const deadline = Date.now() + (options.verifyAbortMs ?? 1_500);
  const stableStoppedMs = options.stableStoppedMs ?? 300;
  const retryIntervalMs = options.abortRetryIntervalMs ?? 150;
  let stableStoppedSince: number | undefined;
  let lastStatus: string | undefined;
  let statusUnavailable = false;

  while (Date.now() <= deadline) {
    assertLease(options.backgroundJobBoard, lease, execution);
    const status = await getSessionStatus(
      options.input,
      execution.taskID,
      Math.max(1, deadline - Date.now()),
      lease,
      options.backgroundJobBoard,
    );
    assertLease(options.backgroundJobBoard, lease, execution);
    if (status.source === 'status-unavailable') {
      // v2 hosts expose no session.status map; polling it can never answer
      // 'idle'. Fall back to host session info (terminal outcome or a
      // fresh idle timestamp) instead of failing a confirmed abort.
      statusUnavailable = true;
      break;
    }
    lastStatus = status.status;
    const quiescent = status.status === 'idle';
    if (!quiescent) {
      stableStoppedSince = undefined;
      await delay(retryIntervalMs);
      continue;
    }
    stableStoppedSince ??= Date.now();
    if (Date.now() - stableStoppedSince >= stableStoppedMs) return;
    await delay(retryIntervalMs);
  }

  if (statusUnavailable) {
    await verifyQuiescentViaHostInfo(
      options,
      execution,
      lease,
      abortStartedAt,
      deadline,
    );
    return;
  }

  throw new SessionStillRunningError(
    `Session abort returned but task did not stay stopped: ${execution.taskID} (${lastStatus ?? 'unknown'})`,
  );
}

/**
 * v2 verification fallback: the host publishes the terminal outcome and an
 * idle timestamp on Session.Info. Quiescence is confirmed by either a
 * terminal outcome or an idle timestamp at/after the abort began.
 */
async function verifyQuiescentViaHostInfo(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  lease: BackgroundJobLease,
  abortStartedAt: number,
  deadline: number,
): Promise<void> {
  const retryIntervalMs = options.abortRetryIntervalMs ?? 150;
  let lastDetail = 'no host session info';
  while (Date.now() <= deadline) {
    assertLease(options.backgroundJobBoard, lease, execution);
    const client = getClient(options.input);
    if (typeof client.session.get !== 'function') {
      // No status map AND no session info — nothing to verify against.
      throw new SessionStillRunningError(
        `Session abort returned but quiescence cannot be verified on this host: ${execution.taskID}`,
      );
    }
    try {
      const response = (await client.session.get({
        path: { id: execution.taskID },
        query: { directory: options.input.directory },
      })) as {
        data?: { outcome?: unknown; time?: { idle?: unknown } };
        outcome?: unknown;
        time?: { idle?: unknown };
      };
      const info = response?.data ?? response;
      const outcome = info?.outcome;
      // Whitelist the known terminal values: a malformed or future
      // nonterminal outcome string must NOT confirm quiescence on its own —
      // it falls through to the idle-timestamp evidence below.
      if (typeof outcome === 'string' && isHostTerminalOutcome(outcome)) {
        return;
      }
      const idleAt = info?.time?.idle;
      if (typeof idleAt === 'number' && idleAt >= abortStartedAt) {
        return;
      }
      lastDetail =
        typeof outcome === 'string'
          ? `outcome=${outcome}`
          : typeof idleAt === 'number'
            ? `idle=${idleAt}`
            : 'no outcome or idle timestamp';
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await delay(retryIntervalMs);
  }
  throw new SessionStillRunningError(
    `Session abort returned but task did not stay stopped: ${execution.taskID} (host-info: ${lastDetail})`,
  );
}

async function getSessionStatus(
  input: PluginInput,
  taskID: string,
  timeoutMs: number,
  lease: BackgroundJobLease,
  backgroundJobBoard: BackgroundJobStore,
): Promise<{ status: 'busy' | 'retry' | 'idle' | undefined; source: string }> {
  assertLease(backgroundJobBoard, lease, {
    taskID: lease.taskID,
    generation: lease.generation,
  });
  try {
    // Capability pre-check: v2 hosts expose no session.status map. Detect
    // that deterministically (instead of relying on the thrown lookup
    // error) so the verification loop can switch to the host-info path.
    const client =
      typeof input.client?.session?.status === 'function'
        ? input.client
        : getClient(input);
    if (typeof client.session?.status !== 'function') {
      return { status: undefined, source: 'status-unavailable' };
    }
    const snapshot = await awaitLeaseOperation(
      backgroundJobBoard,
      lease,
      () =>
        getRuntimeSessionStatusSnapshot(input, {
          timeoutMs: Math.max(1, timeoutMs),
        }),
      Math.max(1, timeoutMs),
      `Session status lookup timed out after ${Math.max(1, timeoutMs)}ms`,
    );
    const status = runtimeSessionStatus(snapshot, taskID);
    if (status !== undefined) return { status, source: 'task-map-entry' };
    return {
      status: undefined,
      source: snapshot.error
        ? 'lookup-error'
        : snapshot.malformedSessionIDs.has(taskID)
          ? 'malformed-task-map-entry'
          : 'missing-from-map',
    };
  } catch (error) {
    if (error instanceof LeaseOperationTimeoutError) throw error;
    return { status: undefined, source: 'lookup-error' };
  }
}

async function awaitLeaseOperation<T>(
  backgroundJobBoard: BackgroundJobStore,
  lease: BackgroundJobLease,
  operation: () => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timedOut = false;
  let settled = false;
  const underlying = Promise.resolve().then(operation);
  const tracked = underlying.then(
    (value) => {
      settled = true;
      if (timedOut) backgroundJobBoard.releaseLease(lease);
      return value;
    },
    (error: unknown) => {
      settled = true;
      if (timedOut) backgroundJobBoard.releaseLease(lease);
      throw error;
    },
  );

  try {
    return await withTimeout(tracked, timeoutMs, message);
  } catch (error) {
    if (!(error instanceof OperationTimeoutError)) throw error;
    timedOut = true;
    const pending = !settled;
    if (!pending) backgroundJobBoard.releaseLease(lease);
    throw new LeaseOperationTimeoutError(error.message, pending);
  }
}

function assertLease(
  backgroundJobBoard: BackgroundJobStore,
  lease: BackgroundJobLease,
  execution: CapturedExecution,
): void {
  if (
    lease.taskID !== execution.taskID ||
    lease.generation !== execution.generation ||
    lease.kind !== 'cancellation' ||
    !backgroundJobBoard.validateLease(lease)
  ) {
    throw new LeaseOwnershipLostError(
      `Cancellation lease is no longer valid for ${execution.taskID} generation ${execution.generation}`,
    );
  }
}

function assertOrchestrator(
  options: TaskControlToolOptions,
  toolContext: { sessionID?: string; agent?: string } | undefined,
  toolName: string,
): string {
  const parentSessionID = toolContext?.sessionID;
  if (!parentSessionID) throw new Error(`${toolName} requires sessionID`);
  if (toolContext.agent && toolContext.agent !== 'orchestrator') {
    throw new Error(`${toolName} can only be used by orchestrator`);
  }
  if (!options.shouldManageSession(parentSessionID)) {
    throw new Error(`${toolName} can only be used in orchestrator sessions`);
  }
  return parentSessionID;
}

async function untrackedTaskReason(
  options: TaskControlToolOptions,
  parentSessionID: string,
  requested: string,
): Promise<string> {
  if (!SESSION_ID_PATTERN.test(requested))
    return 'unknown or unowned background task';
  if (requested === parentSessionID) return 'cannot cancel parent session';
  const knownJob = options.backgroundJobBoard.get(requested);
  if (
    knownJob &&
    options.backgroundJobBoard.getParentSessionID(requested) !== parentSessionID
  ) {
    return 'unknown or unowned background task';
  }
  const owner = await getSessionParentID(options.input, requested);
  if (owner !== parentSessionID) return 'unknown or unowned background task';
  return 'best-effort/uncertain cancellation: session ownership was observed, but no tracked generation exists; no remote abort was attempted';
}

async function getSessionParentID(
  input: PluginInput,
  taskID: string,
): Promise<string | undefined> {
  try {
    const response = await getClient(input).session.get({
      path: { id: taskID },
      query: { directory: input.directory },
    });
    return response.data?.parentID;
  } catch {
    return undefined;
  }
}

function operationBoolean(response: unknown): boolean | undefined {
  if (response === true || response === false) return response;
  if (!isRecord(response)) return undefined;
  return typeof response.data === 'boolean' ? response.data : undefined;
}

function unknownTaskOutput(taskID: string, message: string): string {
  return [
    `task_id: ${taskID}`,
    'state: unknown',
    '',
    '<task_error>',
    message,
    '</task_error>',
  ].join('\n');
}

function isCapturedExecution(
  record: ReturnType<BackgroundJobStore['get']>,
  capturedExecution: CapturedExecution,
): boolean {
  return (
    record?.taskID === capturedExecution.taskID &&
    record.generation === capturedExecution.generation
  );
}

function assertCapturedExecution(
  backgroundJobBoard: BackgroundJobStore,
  execution: CapturedExecution,
): void {
  if (
    !isCapturedExecution(backgroundJobBoard.get(execution.taskID), execution)
  ) {
    throw new Error(
      `stale/uncertain cancellation: ${execution.taskID} generation changed`,
    );
  }
}

function staleCancellationOutput(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  detail: string,
): string {
  const current = options.backgroundJobBoard.get(execution.taskID);
  return [
    `task_id: ${execution.taskID}`,
    `state: ${current?.state ?? 'unknown'}`,
    '',
    '<task_error>',
    `stale/uncertain cancellation: ${detail}`,
    '</task_error>',
  ].join('\n');
}
