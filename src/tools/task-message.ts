import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  type ContinuationModelSelection,
  parseContinuationModelSelection,
} from '../hooks/task-session-manager/continuation-model-selection';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getClient } from '../utils/opencode-client';
import { OperationTimeoutError, withTimeout } from '../utils/session';
import type { TaskControlIdentityIndex } from './task-control-recovery';
import {
  createTaskControlRecovery,
  type TaskControlRecovery,
} from './task-control-recovery';

const z = tool.schema;
const MAX_MESSAGE_LENGTH = 500;
const DEFAULT_MESSAGE_TIMEOUT_MS = 10_000;
const MODEL_LOOKUP_HISTORY_LIMIT = 20;

class MessageLeaseOperationTimeoutError extends Error {
  constructor(
    message: string,
    readonly pending: boolean,
  ) {
    super(message);
    this.name = 'MessageLeaseOperationTimeoutError';
  }
}

export function createTaskMessageTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  messageTimeoutMs?: number;
  identityIndex?: TaskControlIdentityIndex;
  recovery?: TaskControlRecovery;
}): Record<'task_message', ToolDefinition> {
  const recovery =
    options.recovery ??
    createTaskControlRecovery({
      input: options.input,
      backgroundJobBoard: options.backgroundJobBoard,
      identityIndex: options.identityIndex,
    });
  const task_message = tool({
    description:
      'Queue a bounded message for a live child task without launching, resuming, or interrupting it.',
    args: {
      task_id: z
        .string()
        .describe('Tracked live task ID or parent-scoped alias'),
      message: z
        .string()
        .trim()
        .min(1)
        .max(MAX_MESSAGE_LENGTH)
        .describe('Short message to queue for the child task'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_message requires sessionID');

      const requested = args.task_id.trim();
      const target = await recovery.resolve(parentSessionID, requested);
      if (target.kind === 'unknown')
        throw new Error(`Unknown task ID or alias: ${args.task_id}`);
      if (target.kind === 'orphan') {
        throw new Error(
          `Task ${requested} cannot queue a message: ${target.classification.kind} orphan recovery is not safe (${target.reason}); no prompt was sent`,
        );
      }
      const job = target.job;

      const currentJob = getCurrentTaskMessageJob(
        options.backgroundJobBoard,
        parentSessionID,
        requested,
        job.taskID,
        job.generation,
      );

      const lease = options.backgroundJobBoard.acquireMessageLease(
        currentJob.taskID,
        currentJob.generation,
      );
      if (!lease) {
        throw new Error(
          `Task ${requested} cannot queue a message: message/control lease unavailable`,
        );
      }

      let keepLeaseUntilSettled = false;
      let operationClaim: string | undefined;
      let promptInvoked = false;
      let operationSettled = false;

      const settleOperation = (
        resolution:
          | 'pre_send_failure'
          | 'authoritative_rejection'
          | 'accepted_and_completed',
      ): void => {
        if (!operationClaim || operationSettled) return;
        operationSettled = true;
        recovery.settleOperation(
          parentSessionID,
          lease.taskID,
          'message',
          operationClaim,
          resolution,
        );
      };

      const settlePromptOutcome = (response: unknown): void => {
        if (!operationClaim) return;
        try {
          if (messageResponseError(response) !== undefined) {
            settleOperation('authoritative_rejection');
            return;
          }
          const accepted = recovery.markOperationAccepted(
            parentSessionID,
            lease.taskID,
            'message',
            operationClaim,
          );
          if (accepted === false) return;
          settleOperation('accepted_and_completed');
        } catch {
          // A late callback must never become an unhandled rejection. Keeping
          // the claim is the safe outcome if a transition cannot be recorded.
        }
      };

      const settlePromptFailure = (error: unknown): void => {
        if (
          !promptInvoked ||
          !operationClaim ||
          !isAuthoritativeApiRejection(error)
        )
          return;
        try {
          settleOperation('authoritative_rejection');
        } catch {
          // Preserve the durable claim if the settlement write itself fails.
        }
      };
      try {
        assertMessageLease(options.backgroundJobBoard, lease, requested);
        getCurrentTaskMessageJob(
          options.backgroundJobBoard,
          parentSessionID,
          requested,
          lease.taskID,
          lease.generation,
        );

        const messageTimeoutMs = Math.max(
          1,
          options.messageTimeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS,
        );
        if (recovery.hasDurableOperationClaims()) {
          let baseline: Awaited<
            ReturnType<TaskControlRecovery['readLatestChildUser']>
          >;
          try {
            baseline = await withTimeout(
              recovery.readLatestChildUser(lease.taskID),
              messageTimeoutMs,
              `Task ${requested} latest child user baseline lookup timed out after ${messageTimeoutMs}ms`,
            );
          } catch (error) {
            throw new Error(
              `Task ${requested} cannot queue a message: verifiable latest child user baseline unavailable (${errorText(error)}); refusing message without sending a prompt`,
              { cause: error },
            );
          }
          if (!baseline) {
            throw new Error(
              `Task ${requested} cannot queue a message: verifiable latest child user baseline unavailable; refusing message without sending a prompt`,
            );
          }
          operationClaim = recovery.claimOperation(
            parentSessionID,
            lease.taskID,
            'message',
            baseline,
          );
          if (!operationClaim) {
            throw new Error(
              `Task ${requested} cannot queue a message: a durable message/revive operation is already unsettled`,
            );
          }
        }

        const session = getClient(options.input).session;
        const promptMethod = session.prompt;
        if (typeof promptMethod !== 'function') {
          throw new Error(
            'The host session does not support session.prompt; the prompt was NOT sent',
          );
        }
        const prompt = promptMethod.bind(session);
        const deadline = Date.now() + messageTimeoutMs;
        let modelSelection: ContinuationModelSelection | undefined;
        // v2 prompts inherit persisted session selection; per-call overrides
        // cannot be represented atomically. Keep the v1 lookup/pin unchanged.
        if ((options.input as { hostFlavor?: string }).hostFlavor !== 'v2') {
          const lookupController = new AbortController();
          try {
            modelSelection = await withTimeout(
              readCurrentChildModel(
                session,
                lease.taskID,
                options.input.directory,
                lookupController.signal,
              ),
              messageTimeoutMs,
              `Task message model lookup timed out after ${messageTimeoutMs}ms`,
            );
          } finally {
            lookupController.abort();
          }
          if (!modelSelection) {
            throw new Error(
              `Task ${requested} has no authoritative model identity; refusing message`,
            );
          }
        }

        const remainingTimeoutMs = deadline - Date.now();
        if (remainingTimeoutMs <= 0) {
          throw new OperationTimeoutError(
            `Task message transport timed out after ${messageTimeoutMs}ms`,
          );
        }

        const response = await awaitMessageTransport(
          options.backgroundJobBoard,
          lease,
          () => {
            assertMessageLease(options.backgroundJobBoard, lease, requested);
            const currentJob = getCurrentTaskMessageJob(
              options.backgroundJobBoard,
              parentSessionID,
              requested,
              lease.taskID,
              lease.generation,
            );
            const body = {
              ...(modelSelection
                ? {
                    agent: currentJob.agent,
                    model: modelSelection.model,
                    variant: modelSelection.variant ?? 'default',
                  }
                : {}),
              noReply: true,
              parts: [{ type: 'text', text: args.message.trim() }],
            } as Parameters<typeof prompt>[0]['body'];
            if (operationClaim) {
              const sent = recovery.markOperationSent(
                parentSessionID,
                lease.taskID,
                'message',
                operationClaim,
              );
              if (sent !== true) {
                throw new Error(
                  `Task ${requested} message operation claim could not be marked sent (transition unavailable or claim fence lost); the prompt was NOT sent`,
                );
              }
            }
            promptInvoked = true;
            return prompt({
              path: { id: lease.taskID },
              body,
              throwOnError: true,
            });
          },
          remainingTimeoutMs,
          {
            onFulfilled: settlePromptOutcome,
            onRejected: settlePromptFailure,
          },
        );
        assertMessageLease(options.backgroundJobBoard, lease, requested);
        assertSuccessfulMessageResponse(response);

        const latestJob = getCurrentTaskMessageJob(
          options.backgroundJobBoard,
          parentSessionID,
          requested,
          lease.taskID,
          lease.generation,
        );
        return `Message queued for ${latestJob.alias} (${latestJob.taskID}) without launching or resuming it.`;
      } catch (error) {
        if (operationClaim && !promptInvoked) {
          try {
            settleOperation('pre_send_failure');
          } catch {
            // Preserve the original pre-send failure if settlement is broken.
          }
        }
        keepLeaseUntilSettled =
          error instanceof MessageLeaseOperationTimeoutError && error.pending;
        throw error;
      } finally {
        if (!keepLeaseUntilSettled) {
          options.backgroundJobBoard.releaseLease(lease);
        }
      }
    },
  });

  return { task_message };
}

function assertMessageLease(
  backgroundJobBoard: BackgroundJobStore,
  lease: NonNullable<ReturnType<BackgroundJobStore['acquireMessageLease']>>,
  requested: string,
): void {
  if (lease.kind !== 'message' || !backgroundJobBoard.validateLease(lease)) {
    throw new Error(
      `Task ${requested} message lease is no longer valid; refusing stale message`,
    );
  }
}

async function awaitMessageTransport<T>(
  backgroundJobBoard: BackgroundJobStore,
  lease: NonNullable<ReturnType<BackgroundJobStore['acquireMessageLease']>>,
  operation: () => Promise<T>,
  timeoutMs: number,
  observers?: {
    onFulfilled: (value: T) => void;
    onRejected: (error: unknown) => void;
  },
): Promise<T> {
  let timedOut = false;
  let settled = false;
  const underlying = Promise.resolve().then(operation);
  const tracked = underlying.then(
    (value) => {
      settled = true;
      try {
        observers?.onFulfilled(value);
      } finally {
        if (timedOut) backgroundJobBoard.releaseLease(lease);
      }
      return value;
    },
    (error: unknown) => {
      settled = true;
      try {
        observers?.onRejected(error);
      } finally {
        if (timedOut) backgroundJobBoard.releaseLease(lease);
      }
      throw error;
    },
  );

  try {
    return await withTimeout(
      tracked,
      timeoutMs,
      `Task message transport timed out after ${timeoutMs}ms`,
    );
  } catch (error) {
    if (!(error instanceof OperationTimeoutError)) throw error;
    timedOut = true;
    const pending = !settled;
    if (!pending) backgroundJobBoard.releaseLease(lease);
    throw new MessageLeaseOperationTimeoutError(error.message, pending);
  }
}

function assertSuccessfulMessageResponse(response: unknown): void {
  const responseError = messageResponseError(response);
  if (responseError === undefined) return;
  throw new Error(`Task message transport failed: ${errorText(responseError)}`);
}

function messageResponseError(response: unknown): unknown {
  if (response === false || response === null) {
    return 'session.prompt did not admit the message';
  }
  if (!isRecord(response) || response.error === undefined) return undefined;
  return response.error === null ? undefined : response.error;
}

function rejectionStatus(error: Record<string, unknown>): number | undefined {
  if (typeof error.status === 'number') return error.status;
  if (isRecord(error.cause) && typeof error.cause.status === 'number')
    return error.cause.status;
  return undefined;
}

/** Only an explicit 4xx, including `cause.status`, refused the message.
 * A 5xx, a status-less throw, or a transport error may already have
 * admitted it, so the durable claim stays. */
function isAuthoritativeApiRejection(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const status = rejectionStatus(error);
  return status !== undefined && status >= 400 && status < 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function readCurrentChildModel(
  session: unknown,
  taskID: string,
  directory: string | undefined,
  signal: AbortSignal,
): Promise<ContinuationModelSelection | undefined> {
  if (!isRecord(session)) return undefined;

  const query = directory ? { directory } : undefined;
  let get: unknown;
  try {
    get = session.get;
  } catch {
    get = undefined;
  }
  if (typeof get === 'function') {
    try {
      const response = await get.call(session, {
        path: { id: taskID },
        query,
        signal,
      });
      if (isRecord(response) && isRecord(response.data)) {
        const selection = parseContinuationModelSelection(
          response.data.model,
          response.data.variant,
        );
        if (selection) return selection;
      }
    } catch {
      // Fall through to the authoritative latest user message.
      if (signal.aborted) return undefined;
    }
  }
  if (signal.aborted) return undefined;

  let messages: unknown;
  try {
    messages = session.messages;
  } catch {
    messages = undefined;
  }
  if (typeof messages !== 'function') return undefined;

  try {
    const messageQuery = {
      ...(directory ? { directory } : {}),
      limit: MODEL_LOOKUP_HISTORY_LIMIT,
    };
    const response = await messages.call(session, {
      path: { id: taskID },
      query: messageQuery,
      signal,
    });
    if (!isRecord(response) || !Array.isArray(response.data)) return undefined;

    for (let index = response.data.length - 1; index >= 0; index -= 1) {
      const message = response.data[index];
      if (!isRecord(message) || !isRecord(message.info)) continue;
      if (message.info.role !== 'user') continue;
      return parseContinuationModelSelection(
        message.info.model,
        message.info.variant,
      );
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getCurrentTaskMessageJob(
  backgroundJobBoard: BackgroundJobStore,
  parentSessionID: string,
  requested: string,
  expectedTaskID: string,
  expectedGeneration: number,
): NonNullable<ReturnType<BackgroundJobStore['get']>> {
  const current = backgroundJobBoard.get(expectedTaskID);
  const resolved = backgroundJobBoard.resolve(parentSessionID, requested);
  if (!current || !resolved || resolved.taskID !== expectedTaskID) {
    throw new Error(
      `Task ${requested} is no longer tracked; refusing stale message`,
    );
  }
  if (
    current.taskID !== expectedTaskID ||
    current.generation !== expectedGeneration ||
    resolved.generation !== expectedGeneration
  ) {
    throw new Error(
      `Task ${requested} run generation changed; refusing stale message`,
    );
  }
  if (current.cancellationRequested) {
    throw new Error(
      `Task ${requested} cannot queue a message: cancellation was requested`,
    );
  }
  if (current.state !== 'running') {
    if (current.state === 'stopped') {
      throw new Error(
        `Task ${requested} stopped without a terminal result. task_message only queues messages for running tasks and does not continue it. Use task_revive with task_id: "${requested}" to continue the retained session.`,
      );
    }
    const terminalState =
      current.state === 'reconciled'
        ? (current.terminalState ?? 'completed')
        : current.state;
    if (['completed', 'error', 'cancelled'].includes(terminalState)) {
      throw new Error(
        `Task ${requested} is terminal (${terminalState}). task_message only queues messages for running tasks and does not continue it. Call task_result first if its terminal result is not yet acknowledged; once it appears under Reusable Sessions, resume it with task by passing task_id: "${requested}", its existing ${current.agent} specialist, a new prompt, and background: true.`,
      );
    }
    throw new Error(
      `Task ${requested} cannot queue a message: board state is ${current.state}, not running`,
    );
  }
  return current;
}
