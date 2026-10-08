import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type {
  BackgroundJobLease,
  BackgroundJobLifecycle,
  ObservationToken,
} from '../background-jobs';
import type {
  RetainedRecoveryRequest,
  RetainedRecoveryResult,
} from '../hooks/task-session-manager/session-recovery';
import { pluginDisposedMessage } from '../hooks/task-session-manager/session-recovery';
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
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  taskRefArgs,
} from './task-ref';

const z = tool.schema;

export interface TaskControlToolOptions {
  input: PluginInput;
  backgroundJobs: BackgroundJobLifecycle;
  shouldManageSession: (sessionID: string) => boolean;
  abortTimeoutMs?: number;
  verifyAbortMs?: number;
  abortRetryIntervalMs?: number;
  stableStoppedMs?: number;
  /** Read-only host recovery for a reference the board does not know. */
  recoverRetainedSession?: (
    request: RetainedRecoveryRequest,
  ) => Promise<RetainedRecoveryResult>;
  /** Shared read-only alias gate. Exact session ids do not read parent history. */
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
  isDisposed?: () => boolean;
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
  const idParam = idParamFor(options.input);
  const task_cancel = tool({
    description: `Cancel a tracked background specialist task without deleting its session.

Use only for obsolete, wrong, conflicting, or user-requested cancellation. The retained session can be revived after the lifecycle lane acknowledges its terminal state.`,
    args: {
      ...taskRefArgs(idParam),
      reason: z.string().optional().describe('Short cancellation reason'),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertOrchestrator(
        options,
        toolContext,
        'task_cancel',
      );
      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_cancel requires ${idParam}`);
      const canonical = options.resolveCanonicalTaskRef
        ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
        : undefined;
      if (options.isDisposed?.()) {
        return unknownTaskOutput(idParam, requested, pluginDisposedMessage());
      }
      if (canonical?.kind === 'refused') {
        return unknownTaskOutput(idParam, requested, canonical.reason);
      }
      const identity = canonical?.taskID ?? requested;
      const job = canonical
        ? options.backgroundJobs.get(identity)
        : options.backgroundJobs.resolve(parentSessionID, requested);
      if (job && job.parentSessionID !== parentSessionID) {
        return unknownTaskOutput(
          idParam,
          identity,
          `Task ${identity} belongs to a different parent session. No action was sent.`,
        );
      }
      if (!job) {
        if (options.recoverRetainedSession) {
          const recovery = await options.recoverRetainedSession({
            parentSessionID,
            requested: identity,
          });
          const restored = canonical
            ? options.backgroundJobs.get(identity)
            : options.backgroundJobs.resolve(parentSessionID, requested);
          if (restored) {
            if (restored.state === 'running' || restored.statusUncertain) {
              return unknownTaskOutput(
                idParam,
                restored.taskID,
                'The host session is still executing. task_cancel did not take over an untracked busy session, and no abort was sent.',
              );
            }
            const state =
              restored.state === 'reconciled'
                ? (restored.terminalState ?? restored.state)
                : restored.state;
            return [
              `${idParam}: ${restored.taskID}`,
              `state: ${state}`,
              '',
              '<task_error>',
              `Task is ${state}, not running. No abort was sent.`,
              '</task_error>',
            ].join('\n');
          }
          if (recovery.kind === 'refused') {
            return unknownTaskOutput(idParam, requested, recovery.reason);
          }
        }
        return unknownTaskOutput(
          idParam,
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
          idParam,
          options,
          execution,
          `task is ${job.state}, not running`,
        );
      }

      try {
        await cancelTrackedExecution(options, execution, args.reason);
      } catch (error) {
        const current = options.backgroundJobs.get(execution.taskID);
        const message = error instanceof Error ? error.message : String(error);
        return [
          `${idParam}: ${execution.taskID}`,
          `state: ${current?.state ?? 'unknown'}`,
          '',
          '<task_error>',
          message,
          '</task_error>',
        ].join('\n');
      }

      const state = options.backgroundJobs.getState(execution.taskID);
      return [
        `${idParam}: ${execution.taskID}`,
        `state: ${state ?? 'cancelled'}`,
        '',
        '<task_error>',
        options.backgroundJobs.getResultSummary(execution.taskID) ??
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
  if (options.isDisposed?.()) {
    throw new Error(pluginDisposedMessage());
  }
  const lease = options.backgroundJobs.acquireCancellationLease(
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
    const token = await abortAndVerifySession(options, execution, lease);
    assertCapturedExecution(options.backgroundJobs, execution);
    const observed = options.backgroundJobs.observe(token, {
      kind: 'quiescent',
      origin: 'cancel-verifier',
      readStartedAt: token.readStartedAt,
      stable: true,
    });
    if (observed.kind === 'stale')
      throw new SessionStillRunningError(
        'Activity changed during cancellation verification',
      );
    const result = await options.backgroundJobs.reconcile(execution, {
      kind: 'cancel',
      lease,
      reason,
    });
    const marked = result.kind === 'committed' ? result.record : undefined;
    if (!isCapturedExecution(marked, execution)) {
      throw new Error(
        `stale/uncertain cancellation: ${execution.taskID} generation changed`,
      );
    }
  } catch (error) {
    keepLeaseUntilSettled =
      error instanceof LeaseOperationTimeoutError && error.pending;
    const message = error instanceof Error ? error.message : String(error);
    options.backgroundJobs.markStatusUncertain(
      execution.taskID,
      message,
      execution.generation,
    );
    throw error;
  } finally {
    if (!keepLeaseUntilSettled) {
      options.backgroundJobs.releaseLease(lease);
    }
  }
}

async function abortAndVerifySession(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  lease: BackgroundJobLease,
): Promise<ObservationToken> {
  assertLease(options.backgroundJobs, lease, execution);
  const taskID = execution.taskID;
  const abortStartedAt = Date.now();
  let response: unknown;
  try {
    response = await awaitLeaseOperation(
      options.backgroundJobs,
      lease,
      () => {
        // awaitLeaseOperation defers this callback to a microtask. Ownership
        // may have changed since the check above; never send a stale abort.
        assertLease(options.backgroundJobs, lease, execution);
        assertCapturedExecution(options.backgroundJobs, execution);
        if (options.isDisposed?.()) {
          throw new LeaseOwnershipLostError(pluginDisposedMessage());
        }
        if (options.backgroundJobs.getState(taskID) !== 'running') {
          throw new LeaseOwnershipLostError(
            `stale/uncertain cancellation: ${taskID} is no longer running`,
          );
        }
        return getClient(options.input).session.abort({ path: { id: taskID } });
      },
      options.abortTimeoutMs ?? 10_000,
      `Session abort timed out after ${options.abortTimeoutMs ?? 10_000}ms`,
    );
  } catch (error) {
    assertLease(options.backgroundJobs, lease, execution);
    throw error;
  }
  assertLease(options.backgroundJobs, lease, execution);
  const error = responseError(response);
  if (error !== undefined) throw new Error(stringifyError(error));
  if (operationBoolean(response) === false) {
    throw new Error(`Session abort was not confirmed: ${taskID}`);
  }

  return verifyQuiescentSession(options, execution, lease, abortStartedAt);
}

async function verifyQuiescentSession(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  lease: BackgroundJobLease,
  abortStartedAt: number,
): Promise<ObservationToken> {
  const deadline = Date.now() + (options.verifyAbortMs ?? 1_500);
  const gate = options.backgroundJobs;
  const stableStoppedMs = options.stableStoppedMs ?? 300;
  const retryIntervalMs = options.abortRetryIntervalMs ?? 150;
  let stableStoppedSince: number | undefined;
  let stableActivityRevision: number | undefined;
  let lastStatus: string | undefined;
  let statusUnavailable = false;

  while (Date.now() <= deadline) {
    assertLease(options.backgroundJobs, lease, execution);
    const token = gate.capture(execution);
    if (!token)
      throw new LeaseOwnershipLostError('Cancellation execution changed');
    if (stableActivityRevision !== token.activityRevision)
      stableStoppedSince = undefined;
    const status = await getSessionStatus(
      options.input,
      execution.taskID,
      Math.max(1, deadline - Date.now()),
      lease,
      options.backgroundJobs,
    );
    assertLease(options.backgroundJobs, lease, execution);
    if (status.source === 'status-unavailable') {
      // v2 hosts expose no session.status map; polling it can never answer
      // 'idle'. Fall back to host session info (terminal outcome or a
      // fresh idle timestamp) instead of failing a confirmed abort.
      statusUnavailable = true;
      break;
    }
    lastStatus = status.status;
    // Activity-map contract (verified on the host core): entries are
    // REMOVED when a session goes idle, so a valid status map without an
    // entry for this session is quiescence evidence — not a failed
    // lookup. Explicit busy/retry entries and real failures (lookup
    // error, malformed entry) still refuse to confirm.
    const quiescent =
      status.status === 'idle' ||
      (status.status === undefined && status.source === 'missing-from-map');
    const observation = gate.observe(token, {
      kind: quiescent
        ? 'quiescent'
        : status.status === 'busy' || status.status === 'retry'
          ? status.status
          : 'unknown',
      origin: 'cancel-verifier',
      readStartedAt: token.readStartedAt,
    });
    if (observation.kind === 'stale') {
      stableStoppedSince = undefined;
      await delay(retryIntervalMs);
      continue;
    }
    if (!quiescent) {
      stableStoppedSince = undefined;
      await delay(retryIntervalMs);
      continue;
    }
    stableActivityRevision = token.activityRevision;
    stableStoppedSince ??= Date.now();
    if (Date.now() - stableStoppedSince >= stableStoppedMs) return token;
    await delay(retryIntervalMs);
  }

  if (statusUnavailable) {
    return verifyQuiescentViaHostInfo(
      options,
      execution,
      lease,
      abortStartedAt,
      deadline,
    );
  }

  throw new SessionStillRunningError(
    `Session abort returned but task did not stay stopped: ${execution.taskID} (${lastStatus ?? 'unknown'})`,
  );
}

/**
 * v2 has no session-status map. Interrupt acceptance is not settlement.
 * Prefer the host idle wait. Otherwise only a new idle timestamp counts.
 * A stored outcome does not.
 */
async function verifyQuiescentViaHostInfo(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  lease: BackgroundJobLease,
  abortStartedAt: number,
  deadline: number,
): Promise<ObservationToken> {
  rememberStopEpoch(options, lease, execution.taskID);
  const wait = sessionIdleWait(options.input);
  if (wait) {
    return confirmCancelAfterIdleWait(
      options,
      execution,
      lease,
      deadline,
      wait,
    );
  }
  const retryIntervalMs = options.abortRetryIntervalMs ?? 150;
  let lastDetail = 'no fresh idle evidence';
  while (Date.now() <= deadline) {
    assertStopFences(options, execution, lease);
    const client = getClient(options.input);
    if (typeof client.session.get !== 'function') {
      throw new SessionStillRunningError(
        `Session abort returned but quiescence cannot be verified on this host: ${execution.taskID}`,
      );
    }
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const response = (await withTimeout(
        client.session.get({
          path: { id: execution.taskID },
          query: { directory: options.input.directory },
        }),
        remainingMs,
        `Session info lookup timed out after ${remainingMs}ms`,
      )) as {
        data?: { time?: { idle?: unknown } };
        time?: { idle?: unknown };
      };
      if (Date.now() >= deadline) {
        throw new OperationTimeoutError('Session info lookup timed out');
      }
      assertStopFences(options, execution, lease);
      const info = response?.data ?? response;
      const idleAt = info?.time?.idle;
      if (typeof idleAt === 'number' && idleAt >= abortStartedAt) {
        return freshCancellationToken(options, execution);
      }
      lastDetail =
        typeof idleAt === 'number'
          ? `idle=${idleAt}`
          : 'no fresh idle timestamp';
    } catch (error) {
      if (
        error instanceof LeaseOwnershipLostError ||
        (error instanceof Error &&
          error.message.startsWith('stale/uncertain cancellation:'))
      ) {
        throw error;
      }
      lastDetail = error instanceof Error ? error.message : String(error);
      if (error instanceof OperationTimeoutError) break;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(retryIntervalMs, remainingMs));
  }
  throw new SessionStillRunningError(
    `Session abort returned but task did not stay stopped: ${execution.taskID} (host-info: ${lastDetail})`,
  );
}

async function confirmCancelAfterIdleWait(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  lease: BackgroundJobLease,
  deadline: number,
  wait: (sessionID: string) => Promise<unknown>,
): Promise<ObservationToken> {
  assertStopFences(options, execution, lease);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new SessionStillRunningError(
      `Session abort returned but idle wait was not settled before the deadline: ${execution.taskID}`,
    );
  }
  const waiting = wait(execution.taskID);
  if (!waiting || typeof waiting.then !== 'function') {
    throw new SessionStillRunningError(
      `Session abort returned but waitForSessionIdle did not settle: ${execution.taskID}`,
    );
  }
  try {
    await withTimeout(
      waiting,
      remainingMs,
      `Session idle wait timed out after ${remainingMs}ms`,
    );
  } catch (error) {
    throw new SessionStillRunningError(
      `Session abort returned but idle wait was not settled: ${execution.taskID} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (Date.now() >= deadline) {
    throw new SessionStillRunningError(
      `Session abort returned but idle wait was not settled before the deadline: ${execution.taskID}`,
    );
  }
  assertStopFences(options, execution, lease);
  return freshCancellationToken(options, execution);
}

function sessionIdleWait(
  input: PluginInput,
): ((sessionID: string) => Promise<unknown>) | undefined {
  const channel = (
    input as {
      experimental_v2?: { waitForSessionIdle?: unknown };
    }
  ).experimental_v2?.waitForSessionIdle;
  return typeof channel === 'function'
    ? (channel as (sessionID: string) => Promise<unknown>)
    : undefined;
}

function freshCancellationToken(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
): ObservationToken {
  const token = options.backgroundJobs.capture(execution);
  if (!token)
    throw new LeaseOwnershipLostError('Cancellation execution changed');
  return token;
}

function assertStopFences(
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  lease: BackgroundJobLease,
): void {
  assertLease(options.backgroundJobs, lease, execution);
  assertCapturedExecution(options.backgroundJobs, execution);
  const current = deletionEpoch(options, execution.taskID);
  if (stopEpochs.get(lease) !== current) {
    throw new Error(
      `stale/uncertain cancellation: ${execution.taskID} was deleted`,
    );
  }
}

const stopEpochs = new WeakMap<BackgroundJobLease, number | undefined>();

function rememberStopEpoch(
  options: TaskControlToolOptions,
  lease: BackgroundJobLease,
  taskID: string,
): void {
  stopEpochs.set(lease, deletionEpoch(options, taskID));
}

function deletionEpoch(
  options: TaskControlToolOptions,
  taskID: string,
): number | undefined {
  return options.backgroundJobs.ledger.deletionEpochs.get(taskID);
}

async function getSessionStatus(
  input: PluginInput,
  taskID: string,
  timeoutMs: number,
  lease: BackgroundJobLease,
  backgroundJobs: BackgroundJobLifecycle,
): Promise<{ status: 'busy' | 'retry' | 'idle' | undefined; source: string }> {
  assertLease(backgroundJobs, lease, {
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
      backgroundJobs,
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
  backgroundJobs: BackgroundJobLifecycle,
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
      if (timedOut) backgroundJobs.releaseLease(lease);
      return value;
    },
    (error: unknown) => {
      settled = true;
      if (timedOut) backgroundJobs.releaseLease(lease);
      throw error;
    },
  );

  try {
    return await withTimeout(tracked, timeoutMs, message);
  } catch (error) {
    if (!(error instanceof OperationTimeoutError)) throw error;
    timedOut = true;
    const pending = !settled;
    if (!pending) backgroundJobs.releaseLease(lease);
    throw new LeaseOperationTimeoutError(error.message, pending);
  }
}

function assertLease(
  backgroundJobs: BackgroundJobLifecycle,
  lease: BackgroundJobLease,
  execution: CapturedExecution,
): void {
  if (
    lease.taskID !== execution.taskID ||
    lease.generation !== execution.generation ||
    lease.kind !== 'cancellation' ||
    !backgroundJobs.validateLease(lease)
  ) {
    throw new LeaseOwnershipLostError(
      `Cancellation lease is no longer valid for ${execution.taskID} generation ${execution.generation}`,
    );
  }
}

/** Shared orchestrator-only guard for task control tools: requires a
 * sessionID, rejects non-orchestrator agents, and requires the session to
 * be orchestrator-managed. Returns the validated parent session ID. */
export function assertOrchestrator(
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
  const knownJob = options.backgroundJobs.get(requested);
  if (
    knownJob &&
    options.backgroundJobs.getParentSessionID(requested) !== parentSessionID
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

function unknownTaskOutput(
  idParam: string,
  taskID: string,
  message: string,
): string {
  return [
    `${idParam}: ${taskID}`,
    'state: unknown',
    '',
    '<task_error>',
    message,
    '</task_error>',
  ].join('\n');
}

function isCapturedExecution(
  record: ReturnType<BackgroundJobLifecycle['get']>,
  capturedExecution: CapturedExecution,
): boolean {
  return (
    record?.taskID === capturedExecution.taskID &&
    record.generation === capturedExecution.generation
  );
}

function assertCapturedExecution(
  backgroundJobs: BackgroundJobLifecycle,
  execution: CapturedExecution,
): void {
  if (!isCapturedExecution(backgroundJobs.get(execution.taskID), execution)) {
    throw new Error(
      `stale/uncertain cancellation: ${execution.taskID} generation changed`,
    );
  }
}

function staleCancellationOutput(
  idParam: string,
  options: TaskControlToolOptions,
  execution: CapturedExecution,
  detail: string,
): string {
  const current = options.backgroundJobs.get(execution.taskID);
  return [
    `${idParam}: ${execution.taskID}`,
    `state: ${current?.state ?? 'unknown'}`,
    '',
    '<task_error>',
    `stale/uncertain cancellation: ${detail}`,
    '</task_error>',
  ].join('\n');
}
