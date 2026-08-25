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
}): Record<'task_message', ToolDefinition> {
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
      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!job) throw new Error(`Unknown task ID or alias: ${args.task_id}`);

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
      try {
        assertMessageLease(options.backgroundJobBoard, lease, requested);
        getCurrentTaskMessageJob(
          options.backgroundJobBoard,
          parentSessionID,
          requested,
          lease.taskID,
          lease.generation,
        );

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
              agent: currentJob.agent,
              model: modelSelection.model,
              variant: modelSelection.variant ?? 'default',
              noReply: true,
              parts: [{ type: 'text', text: args.message.trim() }],
            } as Parameters<typeof prompt>[0]['body'];
            return prompt({
              path: { id: lease.taskID },
              body,
              throwOnError: true,
            });
          },
          remainingTimeoutMs,
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
    throw new Error(
      `Task ${requested} cannot queue a message: board state is ${current.state}, not running`,
    );
  }
  return current;
}
