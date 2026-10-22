import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  type ContinuationModelSelection,
  parseContinuationModelSelection,
} from '../hooks/task-session-manager/continuation-model-selection';
import { pluginDisposedMessage } from '../hooks/task-session-manager/session-recovery';
import type { BackgroundJobBoard } from '../utils/background-job-board';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { OperationTimeoutError, withTimeout } from '../utils/session';
import {
  type DelegationWording,
  delegationWording,
  V2_RESUME_CALL,
  v2ResumeCall,
} from '../v2/delegation';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  recentTaskHandles,
  resolveTaskRecord,
  taskRefArgs,
  unknownTaskRefError,
  withRecentTaskHandles,
} from './task-ref';

const z = tool.schema;
const MAX_MESSAGE_LENGTH = 2000;
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
  backgroundJobBoard: BackgroundJobBoard;
  messageTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
  isDisposed?: () => boolean;
}): Record<'task_message', ToolDefinition> {
  const idParam = idParamFor(options.input);
  const hostFlavorAtCreation = (options.input as { hostFlavor?: string })
    .hostFlavor;
  const task_message = tool({
    description:
      'Queue a bounded message for a live child task without launching, resuming, or interrupting it.',
    args: {
      ...taskRefArgs(idParam),
      message: z
        .string()
        .trim()
        .min(1)
        .max(MAX_MESSAGE_LENGTH)
        .describe(
          hostFlavorAtCreation === 'v2'
            ? `Bounded message (max ${MAX_MESSAGE_LENGTH} chars) for the child task; for longer handoffs, continue the session with ${V2_RESUME_CALL} once it settles`
            : `Bounded message (max ${MAX_MESSAGE_LENGTH} chars) for the child task; for longer handoffs, continue the session with task_revive once it settles`,
        ),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_message requires sessionID');

      const hostFlavor = (options.input as { hostFlavor?: string }).hostFlavor;
      const delegation = delegationWording(hostFlavor);

      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_message requires ${idParam}`);
      const ref = await resolveTaskRecord(options, parentSessionID, requested);
      if (ref.kind === 'disposed') throw new Error(pluginDisposedMessage());
      if (ref.kind === 'refused')
        throw new Error(
          withRecentTaskHandles(
            ref.reason,
            recentTaskHandles(options.backgroundJobBoard, parentSessionID),
          ),
        );
      // The await above resumes in a later microtask; a disposal queued in
      // that gap must still stop the send path (the helper's disposed
      // check ran before the gap).
      if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
      const { identity, job } = ref;
      if (job && job.parentSessionID !== parentSessionID) {
        // Another parent's record: not this caller's task, and the
        // settled-session recovery route would reject the same ownership
        // mismatch — keep the bare unknown error.
        throw new Error(`Unknown task ID or alias: ${identity}`);
      }
      if (!job) {
        throw unknownTaskRefError(
          identity,
          delegation.resumeParam,
          recentTaskHandles(options.backgroundJobBoard, parentSessionID),
          hostFlavor,
        );
      }

      const currentJob = getCurrentTaskMessageJob(
        options.backgroundJobBoard,
        parentSessionID,
        job.taskID,
        job.generation,
        delegation,
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
      try {
        const assertCurrentMessage = () => {
          assertMessageLease(options.backgroundJobBoard, lease, requested);
          if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
          return getCurrentTaskMessageJob(
            options.backgroundJobBoard,
            parentSessionID,
            lease.taskID,
            lease.generation,
            delegation,
          );
        };
        assertCurrentMessage();

        const session = getClient(options.input).session;
        const prompt = session.prompt.bind(session);
        const messageTimeoutMs = Math.max(
          1,
          options.messageTimeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS,
        );
        const deadline = Date.now() + messageTimeoutMs;
        let modelSelection: ContinuationModelSelection | undefined;
        // v2 prompts inherit persisted session selection; per-call overrides
        // cannot be represented atomically. Keep the v1 lookup/pin unchanged.
        if (hostFlavor !== 'v2') {
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
          if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
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
            const currentJob = assertCurrentMessage();
            const expectedAgent = currentJob.agent;
            const body = {
              agent: expectedAgent,
              ...(modelSelection
                ? {
                    model: modelSelection.model,
                    variant: modelSelection.variant ?? 'default',
                  }
                : {}),
              noReply: true,
              parts: [{ type: 'text', text: args.message.trim() }],
            } as Parameters<typeof prompt>[0]['body'];
            return prompt({
              path: { id: lease.taskID },
              body,
              throwOnError: true,
              ...(hostFlavor === 'v2'
                ? {
                    // The shim awaits owning-agent validation. Recheck the
                    // same authorization at its final, synchronous admission
                    // boundary rather than after the host has already queued.
                    beforeSend: () => {
                      if (assertCurrentMessage().agent !== expectedAgent) {
                        throw new Error(
                          `Task ${requested} agent changed while preparing its message; refusing stale message`,
                        );
                      }
                    },
                  }
                : {}),
            });
          },
          remainingTimeoutMs,
        );
        assertMessageLease(options.backgroundJobBoard, lease, requested);
        assertSuccessfulMessageResponse(response);

        const latestJob = getCurrentTaskMessageJob(
          options.backgroundJobBoard,
          parentSessionID,
          lease.taskID,
          lease.generation,
          delegation,
        );
        return `Message queued for ${latestJob.alias} (${latestJob.taskID}) without launching or resuming it.`;
      } catch (error) {
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
  backgroundJobBoard: BackgroundJobBoard,
  lease: NonNullable<ReturnType<BackgroundJobBoard['acquireMessageLease']>>,
  requested: string,
): void {
  if (lease.kind !== 'message' || !backgroundJobBoard.validateLease(lease)) {
    throw new Error(
      `Task ${requested} message lease is no longer valid; refusing stale message`,
    );
  }
}

async function awaitMessageTransport<T>(
  backgroundJobBoard: BackgroundJobBoard,
  lease: NonNullable<ReturnType<BackgroundJobBoard['acquireMessageLease']>>,
  operation: () => Promise<T>,
  timeoutMs: number,
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
  if (!isRecord(response) || response.error === undefined) return;
  if (response.error === null) return;
  throw new Error(
    `Task message transport failed: ${errorText(response.error)}`,
  );
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

    // Execution messages reflect hook rewrites; Session.model can be stale.
    for (let index = response.data.length - 1; index >= 0; index -= 1) {
      const message = response.data[index];
      if (!isRecord(message) || !isRecord(message.info)) continue;
      if (message.info.summary === true) continue;
      const selection = parseContinuationModelSelection(
        message.info.role === 'user'
          ? message.info.model
          : message.info.role === 'assistant'
            ? {
                providerID: message.info.providerID,
                modelID: message.info.modelID,
              }
            : undefined,
        message.info.variant,
      );
      if (selection) return selection;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getCurrentTaskMessageJob(
  backgroundJobBoard: BackgroundJobBoard,
  parentSessionID: string,
  expectedTaskID: string,
  expectedGeneration: number,
  delegation: DelegationWording,
): NonNullable<ReturnType<BackgroundJobBoard['get']>> {
  const current = backgroundJobBoard.get(expectedTaskID);
  if (!current || current.parentSessionID !== parentSessionID) {
    throw new Error(
      `Task ${expectedTaskID} is no longer tracked; refusing stale message`,
    );
  }
  if (current.generation !== expectedGeneration) {
    throw new Error(
      `Task ${expectedTaskID} run generation changed; refusing stale message`,
    );
  }
  if (current.cancellationRequested) {
    throw new Error(
      `Task ${expectedTaskID} cannot queue a message: cancellation was requested`,
    );
  }
  if (current.state !== 'running') {
    if (current.state === 'stopped') {
      throw new Error(
        `Task ${expectedTaskID} stopped without a terminal result. task_message only queues messages for running tasks and does not continue it. ${
          delegation.tool === 'subagent'
            ? `Continue the retained session with ${v2ResumeCall(expectedTaskID)}.`
            : `Use task_revive with ${delegation.resumeParam}: "${expectedTaskID}" to continue the retained session.`
        }`,
      );
    }
    const terminalState =
      current.state === 'reconciled'
        ? (current.terminalState ?? 'completed')
        : current.state;
    if (['completed', 'error', 'cancelled'].includes(terminalState)) {
      throw new Error(
        `Task ${expectedTaskID} is terminal (${terminalState}). task_message only queues messages for running tasks and does not continue it. ${
          delegation.tool === 'subagent'
            ? `Continue that same session with ${v2ResumeCall(expectedTaskID)}.`
            : `Continue that same session with task_revive and ${delegation.resumeParam}: "${expectedTaskID}".`
        }`,
      );
    }
    throw new Error(
      `Task ${expectedTaskID} cannot queue a message: board state is ${current.state}, not running`,
    );
  }
  return current;
}
