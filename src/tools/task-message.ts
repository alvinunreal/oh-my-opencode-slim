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
import {
  OperationTimeoutError,
  parseModelReference,
  withTimeout,
} from '../utils/session';
import {
  type CanonicalTaskResolver,
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
  restoreTarget?: (
    sessionID: string,
  ) => { model: string; variant?: string } | undefined;
}): Record<'task_message', ToolDefinition> {
  const task_message = tool({
    description:
      'Queue a bounded message for a live child task without launching, resuming, or interrupting it.',
    args: {
      ...taskRefArgs('task_id'),
      message: z
        .string()
        .trim()
        .min(1)
        .max(MAX_MESSAGE_LENGTH)
        .describe(
          `Bounded message (max ${MAX_MESSAGE_LENGTH} chars) for the child task; for longer handoffs, continue the session with task_revive once it settles`,
        ),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_message requires sessionID');

      const requested = readTaskRef(args, 'task_id');
      if (!requested) throw new Error('task_message requires task_id');
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
          'task_id',
          recentTaskHandles(options.backgroundJobBoard, parentSessionID),
        );
      }

      const currentJob = getCurrentTaskMessageJob(
        options.backgroundJobBoard,
        parentSessionID,
        job.taskID,
        job.generation,
      );

      const lease = options.backgroundJobBoard.acquireLease(
        currentJob.taskID,
        currentJob.generation,
        'message',
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
        const lookupController = new AbortController();
        let modelSelection: ContinuationModelSelection | undefined;
        try {
          const restore = options.restoreTarget?.(lease.taskID);
          modelSelection = restore
            ? parseContinuationModelSelection(
                parseModelReference(restore.model),
                restore.variant,
              )
            : await withTimeout(
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
        const selection = modelSelection;

        const remainingTimeoutMs = deadline - Date.now();
        if (remainingTimeoutMs <= 0) {
          throw new OperationTimeoutError(
            `Task message transport timed out after ${messageTimeoutMs}ms`,
          );
        }

        // The v1 host assigns the admission id: its ids are `msg_` + an
        // ascending hex timestamp, and the run loop orders turns by id
        // string, so a plugin-chosen id would sort after every host id and
        // stay the "latest user" forever. With noReply the host returns the
        // stored user message, whose id becomes this generation's amendment
        // boundary.
        // Commit runs INSIDE the transport operation so a late success (host
        // accepts after our deadline) still stamps its boundary; the tool's
        // return stays a timeout rejection (no retry, no duplicate prompt).
        const commitAccepted = (
          terminalRevision: number,
          messageID: string | undefined,
        ): boolean => {
          if (messageID === undefined) return false;
          if (options.isDisposed?.() === true) return false;
          const latest = options.backgroundJobBoard.get(lease.taskID);
          return (
            latest !== undefined &&
            latest.parentSessionID === parentSessionID &&
            options.backgroundJobBoard.noteRunAmendment(
              lease.taskID,
              lease.generation,
              messageID,
              terminalRevision,
            )
          );
        };
        const deposit = await awaitMessageTransport(
          options.backgroundJobBoard,
          lease,
          async () => {
            // Capture the run the prompt ACTUALLY enters from the validated
            // current job immediately before session.prompt; there is no
            // await between this capture and the dispatch below, so a reopen
            // during the model lookup is either picked up here (the real
            // live run) or refuses before anything is sent.
            const currentJob = assertCurrentMessage();
            const terminalRevision = currentJob.terminalRevision;
            const body = {
              agent: currentJob.agent,
              model: selection.model,
              variant: selection.variant ?? 'default',
              noReply: true,
              parts: [{ type: 'text', text: args.message.trim() }],
            } as Parameters<typeof prompt>[0]['body'];
            const response = await prompt({
              path: { id: lease.taskID },
              body,
              throwOnError: true,
            });
            assertSuccessfulMessageResponse(response);
            assertMessageLease(options.backgroundJobBoard, lease, requested);
            return {
              committed: commitAccepted(
                terminalRevision,
                hostAdmittedMessageID(response),
              ),
            };
          },
          remainingTimeoutMs,
        );
        const latestJob = options.backgroundJobBoard.get(lease.taskID);
        if (!deposit.committed || !latestJob) {
          return `Message accepted for ${lease.taskID}; no amendment boundary was recorded.`;
        }
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
  lease: NonNullable<ReturnType<BackgroundJobBoard['acquireLease']>>,
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
  lease: NonNullable<ReturnType<BackgroundJobBoard['acquireLease']>>,
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

/** The id of the user message the v1 host stored for a noReply prompt. */
function hostAdmittedMessageID(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.data)) return undefined;
  const info = response.data.info;
  if (!isRecord(info) || typeof info.id !== 'string') return undefined;
  return info.id.length > 0 ? info.id : undefined;
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
        `Task ${expectedTaskID} stopped without a terminal result. task_message only queues messages for running tasks and does not continue it. Use task_revive with task_id: "${expectedTaskID}" to continue the retained session.`,
      );
    }
    const terminalState =
      current.state === 'reconciled'
        ? (current.terminalState ?? 'completed')
        : current.state;
    if (['completed', 'error', 'cancelled'].includes(terminalState)) {
      throw new Error(
        `Task ${expectedTaskID} is terminal (${terminalState}). task_message only queues messages for running tasks and does not continue it. Continue that same session with task_revive and task_id: "${expectedTaskID}".`,
      );
    }
    throw new Error(
      `Task ${expectedTaskID} cannot queue a message: board state is ${current.state}, not running`,
    );
  }
  return current;
}
